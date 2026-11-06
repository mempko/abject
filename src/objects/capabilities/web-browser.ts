/**
 * WebBrowser capability object — headless browser automation via Playwright.
 *
 * Provides both stateless one-shot methods (getRenderedHtml, screenshot,
 * extractFromPage) and a stateful page API for multi-step browser interactions
 * (openPage → navigateTo → click/fill/type → getContent → closePage).
 *
 * Server-only: requires playwright to be installed.
 *
 * Where the browser comes from depends on where the backend runs. As a plain
 * Node server, Playwright launches its own Chromium. Inside the desktop app,
 * Playwright attaches over CDP to the Chromium Electron already ships, and
 * BrowserWindowHost opens the windows the pages live in, so the app carries
 * no second browser. Either way every page is a Playwright Page, and all the
 * page methods below work on it the same.
 *
 * A page may be signed in as the person, so an action that submits a form or
 * activates a button asks PermissionBroker first (type `web_action`, scope the
 * site's origin) on behalf of the object that asked for it. See "Consent for
 * consequential actions" below.
 */

import { AbjectId, AbjectMessage, MethodDeclaration } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error, request } from '../../core/message.js';
import { require as requireContract } from '../../core/contracts.js';
import { PermissionDenied, refusalMessage, type PermissionReceipt } from '../../core/permission-outcome.js';
import { Log } from '../../core/timed-log.js';
import { isOwnDesktopUrl } from '../../network/origin-policy.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  decodePng,
  DEFAULT_FRAME_POLL_MS,
  DEFAULT_KEY_FRAME_INTERVAL_MS,
  ViewerFrameSession,
  type RgbaFrame,
  type ViewerFrameOptions,
  type ViewerFrameReply,
} from '../frame-diff.js';
import {
  fitFrameToVideo,
  Vp8Encoder,
  VP8_CODEC,
  type ViewerVideoReply,
  type ViewerVideoStreamState,
} from '../video-encoder.js';

const log = new Log('WebBrowser');

/** Cap on the encoded picture's size: what the viewer can actually display. */
const VIEWER_VIDEO_MAX_WIDTH = 960;
const VIEWER_VIDEO_MAX_HEIGHT = 540;

/** Byte equality, so a page that did not change costs no encode at all. */
function framesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
   * installed. When headful, defaults to 'chrome', except in the desktop app,
   * where pages use the app's own Chromium unless a channel is named.
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
    type: (text: string, opts?: { delay?: number }) => Promise<void>;
    insertText: (text: string) => Promise<void>;
  };
  mouse: {
    click: (x: number, y: number, opts?: { button?: string; clickCount?: number }) => Promise<void>;
    move: (x: number, y: number, opts?: { steps?: number }) => Promise<void>;
    down: (opts?: { button?: string }) => Promise<void>;
    up: (opts?: { button?: string }) => Promise<void>;
    wheel: (deltaX: number, deltaY: number) => Promise<void>;
  };
  setContent: (html: string) => Promise<void>;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  on: (event: string, fn: () => void) => void;
  frames: () => PlaywrightFrame[];
  mainFrame: () => PlaywrightFrame;
  // ARIA snapshot for AI (private Playwright API, stable since ~1.49)
  _snapshotForAI: (opts: { track: string }) => Promise<{ full: string; incremental?: string }>;
  // Locator-based interaction
  locator: (selector: string) => PlaywrightLocator;
};

type PlaywrightFrame = {
  evaluate: (script: string) => Promise<unknown>;
  childFrames: () => PlaywrightFrame[];
  frameElement: () => Promise<{ getAttribute: (name: string) => Promise<string | null>; dispose: () => Promise<void> }>;
  url: () => string;
};

type PlaywrightLocator = {
  count: () => Promise<number>;
  first: () => PlaywrightLocator;
  isVisible: () => Promise<boolean>;
  evaluate: <A>(fn: (el: Element, arg: A) => unknown, arg?: A) => Promise<unknown>;
  click: (opts?: unknown) => Promise<void>;
  fill: (value: string, opts?: unknown) => Promise<void>;
  type: (text: string, opts?: unknown) => Promise<void>;
  selectOption: (values: string | string[] | { label: string }, opts?: unknown) => Promise<string[]>;
  hover: (opts?: unknown) => Promise<void>;
  check: (opts?: unknown) => Promise<void>;
  uncheck: (opts?: unknown) => Promise<void>;
  textContent: () => Promise<string | null>;
  press: (key: string, opts?: unknown) => Promise<void>;
};

/** What a pointer landed on (or what has keyboard focus). */
interface PointTarget {
  tag: string;
  role?: string;
  type?: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// Consequential actions
// ---------------------------------------------------------------------------

/** How an action reaches an element: a click, a key that activates or submits, a form submit. */
type ActionKind = 'click' | 'enter' | 'space' | 'submit';

/** What an action on one element would do, judged in the page at action time. */
interface ActionVerdict {
  /** True when it submits a form or activates a button-like control. */
  consequential: boolean;
  /** The action as the person reads it: `click button "Accept"`. */
  action: string;
  /** What it does: `activates a button`, `submits form "login" to https://… (POST)`. */
  effect: string;
  /** The control it lands on: `button "Accept"`. */
  control: string;
  /** The URL of the document the control lives in (a frame's own, inside a frame). */
  url: string;
}

/**
 * Judge what an action on an element would do, from the element's own
 * properties as the page has them now: tag, type, role, disabled state and
 * form membership. Never from words on the page, which say what a site wants
 * a person to think rather than what the control does.
 *
 * Consequential: activating a button-like control (button, input
 * submit/image/button, role button or menuitem, a link with nothing to follow),
 * submitting a form, and Enter in a form's field (implicit submission), or
 * Enter/Space on a button. Not: following a link, a GET form with a declared
 * action (that is a link with fields), opening a menu or disclosure
 * (aria-haspopup, aria-expanded), a reset button, a disabled control, and
 * anything typed or toggled in a field.
 *
 * Plain page JavaScript in a string, run by Playwright in the page (a compiled
 * function would carry bundler helpers the page does not have). Takes
 * `(element, { kind, mark })`; `mark`, when given, is set as
 * `data-abjects-consent` on the element when the verdict is consequential, so
 * the caller can act on exactly that element once the person approves.
 */
const CLASSIFY_ACTION_SOURCE = String.raw`(el, opts) => {
  const kind = opts && opts.kind, mark = opts && opts.mark;
  const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const up = (n) => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode ? n.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const tagOf = (n) => (n && n.tagName ? n.tagName.toLowerCase() : '');
  const roleOf = (n) => (n && n.getAttribute ? (n.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0] : '');
  const CONTROL_TAGS = ['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option'];
  const CONTROL_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox',
    'radio', 'switch', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'];
  const BUTTON_INPUTS = ['submit', 'image', 'button', 'reset'];
  const isControl = (n) => CONTROL_TAGS.includes(tagOf(n)) || CONTROL_ROLES.includes(roleOf(n));

  const target = el && el.nodeType === 1 ? el : (el && el.parentElement) || null;
  if (!target) return null;
  const doc = target.ownerDocument || document;
  const url = doc.location ? doc.location.href : '';

  const nameOf = (n) => {
    const t = tagOf(n), ty = String(n.type || '').toLowerCase();
    const by = (n.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => { const l = doc.getElementById(id); return l ? (l.innerText || l.textContent || '') : ''; }).join(' ');
    const own = t === 'input' && BUTTON_INPUTS.includes(ty) ? (n.value || n.getAttribute('alt') || '') : '';
    const label = n.labels && n.labels.length ? (n.labels[0].innerText || '') : '';
    const text = t === 'input' || t === 'textarea' || t === 'select' ? '' : (n.innerText || n.textContent || '');
    return clip(n.getAttribute('aria-label') || by || own || label || text || n.getAttribute('title')
      || n.getAttribute('alt') || n.getAttribute('placeholder') || n.getAttribute('name') || '', 80);
  };
  const kindOf = (n) => {
    const t = tagOf(n), r = roleOf(n), ty = String(n.type || '').toLowerCase();
    if (r) return r;
    if (t === 'input') return BUTTON_INPUTS.includes(ty) ? 'button' : 'field';
    if (t === 'a') return 'link';
    if (t === 'textarea' || t === 'select' || n.isContentEditable) return 'field';
    return t;
  };
  const describe = (n) => {
    const name = nameOf(n).replace(/"/g, "'");
    return name ? kindOf(n) + ' "' + name + '"' : kindOf(n);
  };
  const formName = (f) => {
    const name = clip(f.getAttribute('aria-label') || f.getAttribute('name') || f.id || '', 60);
    return name ? 'form "' + name + '"' : 'a form';
  };
  const verdict = (consequential, action, effect, control) => {
    if (consequential && mark) target.setAttribute('data-abjects-consent', mark);
    return { consequential, action, effect, control, url };
  };
  // What submitting this form does. A GET form that names where it goes is a
  // link with fields (a search box), the same as following a link.
  const submission = (form, submitter) => {
    const sub = submitter && submitter.getAttribute ? submitter : null;
    const method = String((sub && sub.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'dialog') return { consequential: false, effect: 'closes a dialog' };
    const declared = sub && sub.hasAttribute('formaction') ? sub.getAttribute('formaction') : form.getAttribute('action');
    const to = sub && sub.hasAttribute('formaction') ? sub.formAction : form.action;
    const named = declared != null && declared.trim() !== '' && !/^\s*javascript:/i.test(declared);
    if (method === 'get' && named) return { consequential: false, effect: 'loads ' + clip(to, 100) + ' like a link (GET form)' };
    return { consequential: true,
      effect: 'submits ' + formName(form) + (named ? ' to ' + clip(to, 100) : '') + (method === 'post' ? ' (POST)' : '') };
  };

  if (kind === 'submit' && tagOf(target) === 'form') {
    const s = submission(target, null);
    return verdict(s.consequential, 'submit ' + formName(target), s.effect, formName(target));
  }

  let c = target;
  while (c && !isControl(c)) c = up(c);
  if (!c) c = target;
  if (tagOf(c) === 'label' && c.control) c = c.control;
  const tag = tagOf(c), role = roleOf(c);
  const type = tag === 'input' || tag === 'button' ? String(c.type || '').toLowerCase() : '';
  const form = ['button', 'input', 'select', 'textarea'].includes(tag) ? c.form : null;
  const opensUi = () => {
    const popup = (c.getAttribute('aria-haspopup') || '').toLowerCase();
    return (popup !== '' && popup !== 'false') || c.hasAttribute('aria-expanded');
  };
  const buttonish = tag === 'button' || (tag === 'input' && BUTTON_INPUTS.includes(type)) || role === 'button' || role === 'menuitem';
  // What activating the control does: a click, or Enter/Space on it.
  const activation = () => {
    if (c.disabled === true) return { consequential: false, effect: 'disabled, does nothing' };
    if (tag === 'a' && role !== 'button' && role !== 'menuitem') {
      const href = (c.getAttribute('href') || '').trim();
      if (href !== '' && href !== '#' && !/^javascript:/i.test(href)) return { consequential: false, effect: 'follows a link' };
      return opensUi() ? { consequential: false, effect: 'opens a menu or panel' }
        : { consequential: true, effect: 'activates a link that leads nowhere but its script' };
    }
    if (tag === 'button' || (tag === 'input' && BUTTON_INPUTS.includes(type))) {
      if (type === 'reset') return { consequential: false, effect: 'resets a form' };
      if ((type === 'submit' || type === 'image') && form) return submission(form, c);
      return opensUi() ? { consequential: false, effect: 'opens a menu or panel' } : { consequential: true, effect: 'activates a button' };
    }
    if (role === 'button' || role === 'menuitem') {
      return opensUi() ? { consequential: false, effect: 'opens a menu or panel' } : { consequential: true, effect: 'activates a ' + role };
    }
    return { consequential: false, effect: 'no button or form here' };
  };

  if (kind === 'click') {
    const a = activation();
    return verdict(a.consequential, 'click ' + describe(c), a.effect, describe(c));
  }
  if (kind === 'space') {
    if (!buttonish) return verdict(false, 'press Space in ' + describe(c), 'types or toggles', describe(c));
    const a = activation();
    return verdict(a.consequential, 'press Space on ' + describe(c), a.effect, describe(c));
  }
  if (kind === 'enter') {
    if (tag === 'textarea' || (tag !== 'input' && !buttonish && c.isContentEditable)) {
      return verdict(false, 'press Enter in ' + describe(c), 'starts a new line', describe(c));
    }
    if (tag === 'input' && !BUTTON_INPUTS.includes(type)) {
      if (!form || ['checkbox', 'radio', 'file', 'range', 'color', 'hidden'].includes(type)) {
        return verdict(false, 'press Enter in ' + describe(c), 'not in a form', describe(c));
      }
      const fallback = Array.from(form.elements).find((e) =>
        (e.tagName === 'BUTTON' || e.tagName === 'INPUT') && (e.type === 'submit' || e.type === 'image')) || null;
      const s = submission(form, fallback);
      return verdict(s.consequential, 'press Enter in ' + describe(c), s.effect, describe(c));
    }
    const a = activation();
    return verdict(a.consequential, 'press Enter on ' + describe(c), a.effect, describe(c));
  }
  const s = form ? submission(form, null) : { consequential: false, effect: 'no form' };
  return verdict(s.consequential, 'submit ' + (form ? formName(form) : describe(c)), s.effect, describe(c));
}`;

/** The classifier as a function Playwright can hand an element to. */
const classifyAction = new Function(`return ${CLASSIFY_ACTION_SOURCE}`)() as
  (el: Element, opts: { kind: ActionKind; mark?: string }) => ActionVerdict | null;

/**
 * Which activation a key press is: Enter (any modifiers, the numpad's too)
 * submits a form field or activates a button; Space activates a button.
 * Anything else (Tab, arrows, letters) is typing or moving, and is not asked
 * about.
 */
function keyKind(key: string): ActionKind | undefined {
  if (typeof key !== 'string' || key.length === 0) return undefined;
  if (key === ' ') return 'space';
  const parts = key.split('+');
  const base = parts[parts.length - 1] || '+';
  if (base === 'Enter' || base === 'NumpadEnter') return 'enter';
  if (base === 'Space' || base === ' ') return 'space';
  return undefined;
}

/** The site a URL belongs to, as a remembered answer names it: an origin. */
function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin && u.origin !== 'null' ? u.origin : u.protocol;
  } catch {
    return url.slice(0, 60) || 'this page';
  }
}

/** A URL as the person needs it to judge an action: no query or fragment, which may hold tokens. */
function pageOf(url: string): string {
  try {
    const u = new URL(url);
    const shown = u.origin && u.origin !== 'null' ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname.slice(0, 40)}`;
    return shown.length > 120 ? `${shown.slice(0, 119)}…` : shown;
  } catch {
    return url.slice(0, 120);
  }
}

/** Whether two verdicts name the same control on the same site (nothing moved while the person decided). */
function sameControl(a: ActionVerdict, b: ActionVerdict | null): boolean {
  return !!b && b.consequential && a.action === b.action && a.control === b.control && siteOf(a.url) === siteOf(b.url);
}

/**
 * How long an action waits on PermissionBroker. The dialog heartbeats while
 * the person decides, which resets this and every caller's timer behind it,
 * so it fires only when the broker itself is gone (as for ShellExecutor).
 */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;

interface TrackedPage {
  page: PlaywrightPage;
  owner: AbjectId;
  createdAt: number;
  lastActivity: number;
  /** Profile key ({workspaceId}/{profileName}) the page was opened against, if any. */
  profileKey?: string;
}

/** Playwright's CDP connection to the desktop app's own Chromium. */
type CdpBrowser = {
  contexts: () => Array<{ pages: () => PlaywrightPage[] }>;
  on: (event: 'disconnected', fn: () => void) => void;
  close: () => Promise<void>;
};

/** Viewport a page gets when the caller names none (Playwright's own default). */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * Subdirectory of a profile directory that holds the desktop app's Electron
 * session. Kept apart from the Playwright user-data-dir that shares the
 * profile directory, since the two lay their files out differently.
 */
const ELECTRON_SESSION_DIR = 'electron-session';

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
    description: 'Click an element on a persistent page. A click that submits a form or activates a button may wait for the person\'s approval and can come back declined (PERMISSION_DENIED).',
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
    description: 'Press a keyboard key (e.g. "Enter", "Tab", "ArrowDown"). Enter in a form field or on a button may wait for the person\'s approval and can come back declined (PERMISSION_DENIED).',
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
        description: 'Screenshot options: { fullPage?, scale? } — scale "css" gives one image pixel per CSS pixel, the coordinate space of clickAt/hoverAt/drag/scroll; "device" (default) is the display\'s native resolution.',
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
    description: 'Perform an action on an element identified by its ARIA snapshot ref. A click or key that submits a form or activates a button may wait for the person\'s approval and can come back declined (PERMISSION_DENIED).',
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
    name: 'viewerFrame',
    description: 'One poll of the change-driven viewer transport. Returns exactly one of three things: { kind: \'unchanged\' } when the freshly captured pixels are identical to the frame the client already holds — no image bytes cross the bus; { kind: \'delta\' } with only the changed rectangles, each a data:image/png;base64 URI, against the frame numbered baseSeq; or { kind: \'key\' } with a whole image, sent on the first poll, on a size change, when forceKey is set (a client that is out of sync asks for this) and once the key-frame interval has elapsed. Poll it no faster than the configured poll cadence (~30fps by default) and only while the view is visible. No ownership check — read-only viewer method.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'options',
        type: {
          kind: 'object',
          properties: {
            forceKey: { kind: 'primitive', primitive: 'boolean' },
            keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
          },
        },
        description: 'Per-poll options: { forceKey? — ask for a whole frame, keyFrameIntervalMs? — override the key-frame cadence for this poll }',
        optional: true,
      },
    ],
    returns: {
      kind: 'union',
      variants: [
        {
          kind: 'object',
          properties: {
            kind: { kind: 'primitive', primitive: 'string' },
            seq: { kind: 'primitive', primitive: 'number' },
            url: { kind: 'primitive', primitive: 'string' },
            title: { kind: 'primitive', primitive: 'string' },
          },
        },
        {
          kind: 'object',
          properties: {
            kind: { kind: 'primitive', primitive: 'string' },
            seq: { kind: 'primitive', primitive: 'number' },
            dataUri: { kind: 'primitive', primitive: 'string' },
            width: { kind: 'primitive', primitive: 'number' },
            height: { kind: 'primitive', primitive: 'number' },
            url: { kind: 'primitive', primitive: 'string' },
            title: { kind: 'primitive', primitive: 'string' },
          },
        },
        {
          kind: 'object',
          properties: {
            kind: { kind: 'primitive', primitive: 'string' },
            seq: { kind: 'primitive', primitive: 'number' },
            baseSeq: { kind: 'primitive', primitive: 'number' },
            width: { kind: 'primitive', primitive: 'number' },
            height: { kind: 'primitive', primitive: 'number' },
            patches: {
              kind: 'array',
              elementType: {
                kind: 'object',
                properties: {
                  x: { kind: 'primitive', primitive: 'number' },
                  y: { kind: 'primitive', primitive: 'number' },
                  width: { kind: 'primitive', primitive: 'number' },
                  height: { kind: 'primitive', primitive: 'number' },
                  dataUri: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
            url: { kind: 'primitive', primitive: 'string' },
            title: { kind: 'primitive', primitive: 'string' },
          },
        },
      ],
    },
  },
  {
    name: 'viewerVideoFrame',
    description: 'One poll of the live view as a VP8 video stream. Returns { kind: \'unchanged\' } when the freshly captured pixels are identical to the frame last encoded — nothing crosses the bus — or { kind: \'video\' } with the VP8 packets that continue the stream (key frames restart it, deltas continue it) for the client to decode with WebCodecs. Poll it no faster than the configured cadence and only while the view is visible. No ownership check — read-only viewer method.',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      {
        name: 'options',
        type: {
          kind: 'object',
          properties: {
            forceKey: { kind: 'primitive', primitive: 'boolean' },
            keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
          },
        },
        description: 'Per-poll options: { forceKey? — restart the stream with a key frame, keyFrameIntervalMs? — override the key-frame cadence }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        kind: { kind: 'primitive', primitive: 'string' },
        seq: { kind: 'primitive', primitive: 'number' },
        key: { kind: 'primitive', primitive: 'boolean' },
        width: { kind: 'primitive', primitive: 'number' },
        height: { kind: 'primitive', primitive: 'number' },
        codec: { kind: 'primitive', primitive: 'string' },
        chunks: { kind: 'array', elementType: { kind: 'object', properties: {
          type: { kind: 'primitive', primitive: 'string' },
          timestamp: { kind: 'primitive', primitive: 'number' },
          data: { kind: 'primitive', primitive: 'string' },
        } } },
        url: { kind: 'primitive', primitive: 'string' },
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'viewerVideoStats',
    description: 'Counters for the codec transport: frames encoded, key frames, inter frames, polls that sent nothing and bytes sent. No ownership check — read-only viewer method.',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle', optional: true },
    ],
    returns: {
      kind: 'array',
      elementType: { kind: 'object', properties: {
        pageId: { kind: 'primitive', primitive: 'string' },
        width: { kind: 'primitive', primitive: 'number' },
        height: { kind: 'primitive', primitive: 'number' },
        seq: { kind: 'primitive', primitive: 'number' },
        keyFrames: { kind: 'primitive', primitive: 'number' },
        deltas: { kind: 'primitive', primitive: 'number' },
        unchangedTicks: { kind: 'primitive', primitive: 'number' },
        bytesSent: { kind: 'primitive', primitive: 'number' },
      } },
    },
  },
  {
    name: 'viewerFrameStats',
    description: 'Readable counters for the viewer frame transport, per page and in total: frames served, unchanged ticks, key frames, deltas, patches, bytes sent and the last seq, plus the configured poll and key-frame cadences. Omit pageId for every page with a session. No ownership check — read-only viewer method.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle; omit for every page that has a frame session',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        pages: {
          kind: 'array',
          elementType: {
            kind: 'object',
            properties: {
              pageId: { kind: 'primitive', primitive: 'string' },
              framesServed: { kind: 'primitive', primitive: 'number' },
              unchangedTicks: { kind: 'primitive', primitive: 'number' },
              keyFrames: { kind: 'primitive', primitive: 'number' },
              deltas: { kind: 'primitive', primitive: 'number' },
              patches: { kind: 'primitive', primitive: 'number' },
              bytesSent: { kind: 'primitive', primitive: 'number' },
              lastSeq: { kind: 'primitive', primitive: 'number' },
              keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
            },
          },
        },
        pollMs: { kind: 'primitive', primitive: 'number' },
        keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
        totals: {
          kind: 'object',
          properties: {
            framesServed: { kind: 'primitive', primitive: 'number' },
            unchangedTicks: { kind: 'primitive', primitive: 'number' },
            keyFrames: { kind: 'primitive', primitive: 'number' },
            deltas: { kind: 'primitive', primitive: 'number' },
            patches: { kind: 'primitive', primitive: 'number' },
            bytesSent: { kind: 'primitive', primitive: 'number' },
          },
        },
      },
    },
  },
  {
    name: 'configureViewerFrame',
    description: 'Adjust the viewer frame transport: pollMs is the fastest cadence a viewer should poll at (default ~33ms, about 30fps), keyFrameIntervalMs how often a whole key frame is re-sent so clients resync (default 2000ms). Omit a value to leave it as it is. No ownership check — viewer configuration method.',
    parameters: [
      {
        name: 'pollMs',
        type: { kind: 'primitive', primitive: 'number' },
        description: 'Fastest poll cadence in ms',
        optional: true,
      },
      {
        name: 'keyFrameIntervalMs',
        type: { kind: 'primitive', primitive: 'number' },
        description: 'How often a whole key frame is re-sent, in ms',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        pollMs: { kind: 'primitive', primitive: 'number' },
        keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
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
    description: 'Dispatch a batch of raw human input events (mouse move/down/up, wheel, key press, text insertion) to any page by pageId, in order. Events go through the browser input pipeline so pages see trusted input with real mouse trails. No ownership check: a viewer takeover method, taken only from the built-in WebBrowserViewer (it is the person\'s own input, so it is never asked about).',
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
    name: 'viewerClosePage',
    description: 'Close any page by its handle, whoever opened it. No ownership check: the viewer lists every open page, so its tabs are usually other objects\' pages, and a person closing one is the person\'s own decision. Taken only from the built-in WebBrowserViewer.',
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
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'evaluate',
    description: 'Execute a JavaScript expression in the context of a persistent page and return the result. A click or submit the script makes on a button or form pauses the script for the person\'s approval; declined, the call fails (PERMISSION_DENIED), approved, that one action runs and the result says the script stopped there.',
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
  // -- Pointer and keyboard: real input at viewport coordinates --
  {
    name: 'clickAt',
    description: 'Click at a point of the visible viewport with real mouse input, as a person would. Coordinates are CSS pixels from the viewport\'s top-left, the same pixels as screenshotPage with scale "css". Returns the element that was under the pointer. A click that submits a form or activates a button may wait for the person\'s approval and can come back declined (PERMISSION_DENIED).',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      { name: 'x', type: { kind: 'primitive', primitive: 'number' }, description: 'Viewport x in CSS pixels' },
      { name: 'y', type: { kind: 'primitive', primitive: 'number' }, description: 'Viewport y in CSS pixels' },
      { name: 'button', type: { kind: 'primitive', primitive: 'string' }, description: "'left' (default), 'right' or 'middle'", optional: true },
      { name: 'clickCount', type: { kind: 'primitive', primitive: 'number' }, description: '1 (default), 2 for a double click, 3 for a triple click', optional: true },
    ],
    returns: { kind: 'object', properties: { target: { kind: 'reference', reference: 'PointTarget' } } },
  },
  {
    name: 'hoverAt',
    description: 'Move the mouse to a point of the visible viewport (opens hover menus and tooltips). Returns the element under the pointer.',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      { name: 'x', type: { kind: 'primitive', primitive: 'number' }, description: 'Viewport x in CSS pixels' },
      { name: 'y', type: { kind: 'primitive', primitive: 'number' }, description: 'Viewport y in CSS pixels' },
    ],
    returns: { kind: 'object', properties: { target: { kind: 'reference', reference: 'PointTarget' } } },
  },
  {
    name: 'drag',
    description: 'Press the mouse at one viewport point, move to another in steps, and release (sliders, drag-and-drop, slide-to-verify).',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      { name: 'fromX', type: { kind: 'primitive', primitive: 'number' }, description: 'Start x in CSS pixels' },
      { name: 'fromY', type: { kind: 'primitive', primitive: 'number' }, description: 'Start y in CSS pixels' },
      { name: 'toX', type: { kind: 'primitive', primitive: 'number' }, description: 'End x in CSS pixels' },
      { name: 'toY', type: { kind: 'primitive', primitive: 'number' }, description: 'End y in CSS pixels' },
    ],
    returns: { kind: 'object', properties: { from: { kind: 'reference', reference: 'PointTarget' }, to: { kind: 'reference', reference: 'PointTarget' } } },
  },
  {
    name: 'scroll',
    description: 'Turn the mouse wheel over a viewport point (default: the centre), scrolling whatever is under it: the page, or a scrollable panel. Returns the window scroll position afterwards.',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      { name: 'deltaY', type: { kind: 'primitive', primitive: 'number' }, description: 'Vertical wheel delta in pixels; positive scrolls down' },
      { name: 'deltaX', type: { kind: 'primitive', primitive: 'number' }, description: 'Horizontal wheel delta in pixels; positive scrolls right', optional: true },
      { name: 'x', type: { kind: 'primitive', primitive: 'number' }, description: 'Viewport x to scroll over', optional: true },
      { name: 'y', type: { kind: 'primitive', primitive: 'number' }, description: 'Viewport y to scroll over', optional: true },
    ],
    returns: {
      kind: 'object',
      properties: {
        scrollX: { kind: 'primitive', primitive: 'number' },
        scrollY: { kind: 'primitive', primitive: 'number' },
        maxScrollY: { kind: 'primitive', primitive: 'number' },
      },
    },
  },
  {
    name: 'typeText',
    description: 'Type text with real key events into whatever has keyboard focus (click the field first). Returns the focused element.',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to type' },
    ],
    returns: { kind: 'object', properties: { focused: { kind: 'reference', reference: 'PointTarget' } } },
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

  /**
   * Reference frame per page for the change-driven viewer transport
   * (viewerFrame): the frame that page's client already holds, so a poll can
   * answer with nothing at all, with the rectangles that differ, or with a
   * whole key frame.
   */
  private viewerSessions: Map<string, ViewerFrameSession> = new Map();
  /** How often a viewer may poll viewerFrame, in ms (~30fps by default). */
  private viewerPollMs = DEFAULT_FRAME_POLL_MS;
  /** How often a whole key frame is re-sent, in ms. */
  private viewerKeyFrameIntervalMs = DEFAULT_KEY_FRAME_INTERVAL_MS;
  /**
   * Live VP8 encodes per page for the codec transport (viewerVideoFrame):
   * the encoder with its reference frames, the pixels last encoded (an idle
   * page sends nothing) and the counters the viewer reports.
   */
  private viewerVideoStreams: Map<string, ViewerVideoStreamState> = new Map();
  private pageCounter = 0;

  /** Cached persistent contexts keyed by `{workspaceId}/{profileName}`. */
  private profileContexts: Map<string, ProfileContext> = new Map();
  /** Cached AbjectId → workspaceId so we don't hit the registry on every call. */
  private callerWorkspaceCache: Map<AbjectId, string> = new Map();
  private registryId?: AbjectId;
  private storageId?: AbjectId;
  /** Absolute base dir for all on-disk profile jars. */
  private profilesRoot: string;

  /** BrowserWindowHost, found only when running inside the desktop app. */
  private windowHostId?: AbjectId;
  /** CDP connection to the desktop app's Chromium, opened on first use. */
  private electronBrowser: Promise<CdpBrowser> | null = null;
  /** Profiles whose Electron session has been opened during this run. */
  private openedElectronProfiles: Set<string> = new Set();
  /** Pages that live in app windows (desktop app), as opposed to launched browsers. */
  private electronPages: WeakSet<object> = new WeakSet();

  /** PermissionBroker, verified built-in; asked before a consequential action. */
  private permissionBrokerId?: AbjectId;
  /**
   * Where a page script's guard lives on `window` while the script runs (see
   * evaluateGuarded). Random per run of this object so a script cannot name
   * it without searching for it.
   */
  private readonly guardKey = `__abjectsGuard_${randomUUID().replace(/-/g, '')}`;

  /** Storage key for the profile metadata index ({name, createdAt, lastUsed}). */
  private static readonly PROFILES_INDEX_KEY = 'web-browser:profiles';

  constructor() {
    super({
      manifest: {
        name: 'WebBrowser',
        description:
          'Low-level headless browser engine. Provides raw page operations: navigate, click, fill forms, take screenshots, extract HTML, and query elements via a stateful page API (open, navigate, interact, read, close). ' +
          'Actions that submit a form or activate a button ask the person first, through PermissionBroker.',
        version: '2.0.0',
        interface: {
            id: WEB_BROWSER_INTERFACE,
            name: 'WebBrowser',
            description: 'Headless browser operations — one-shot and stateful page API',
            methods: [...ONE_SHOT_METHODS, ...STATEFUL_METHODS, ...PROFILE_METHODS],
          },
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
            // A refusal keeps its own code and receipt, so the caller can tell
            // "the person said no" from a page that broke.
            if (err instanceof PermissionDenied) {
              this.send(error(msg, err.code, err.message, err.details));
              return;
            }
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
  // Consent for consequential actions
  // ===========================================================================
  //
  // A page here may be signed in as the person (a persistent profile), so a
  // click that submits or activates something acts in their name. Those go to
  // PermissionBroker (type `web_action`) for the object that asked, before
  // they happen; reading, scrolling, hovering, following links and typing
  // into a field never do. What counts is judged in the page at action time
  // (CLASSIFY_ACTION_SOURCE). The broker and the rules the person set are the
  // whole policy: this object only asks and honours the answer.

  /**
   * Return when the person (or a rule they set) allows this action; throw
   * PermissionDenied with a sentence the calling agent can act on when not.
   * A verdict that is not consequential passes without asking.
   */
  private async requireConsent(requesterId: AbjectId, verdict: ActionVerdict | null | undefined): Promise<void> {
    if (!verdict?.consequential) return;
    requireContract(typeof verdict.action === 'string' && verdict.action.length > 0, 'a consequential action names itself');
    const site = siteOf(verdict.url);
    const resource = `${site}: ${verdict.action}`;
    const what = `${verdict.action} on ${site}`;
    const receipt = (source: PermissionReceipt['source'], reason: string, decision = 'deny'): PermissionReceipt => ({
      authority: this.id, callerId: requesterId, operation: 'web_action', resource, decision, source, reason,
    });
    const refuse = (permission: PermissionReceipt): never => {
      log.info(`not done: ${resource} (${permission.source}: ${permission.reason})`);
      throw new PermissionDenied(permission, refusalMessage(permission, what));
    };

    const brokerId = await this.permissionBroker();
    if (!brokerId) return refuse(receipt('unavailable', 'no permission broker is running'));
    let response: { decision?: string; receipt?: PermissionReceipt } | undefined;
    try {
      response = await this.request<{ decision?: string; receipt?: PermissionReceipt }>(
        request(this.id, brokerId, 'requestPermission', {
          type: 'web_action', scope: site, resource, callerId: requesterId,
          description: verdict.action,
          detail: [`Page       ${pageOf(verdict.url)}`, `Effect     ${verdict.effect}`],
        }),
        PERMISSION_WAIT_MS,
      );
    } catch (err) {
      // A broker that stopped answering may come back under a new id.
      this.permissionBrokerId = undefined;
      return refuse(receipt('unavailable', err instanceof Error ? err.message : String(err)));
    }
    if (response?.decision?.startsWith('accept')) {
      log.info(`approved: ${resource}`);
      return;
    }
    return refuse(response?.receipt ?? receipt('policy', 'refused by PermissionBroker', response?.decision));
  }

  /**
   * The built-in PermissionBroker, found once. A registered name proves
   * nothing by itself, so the id is accepted only from a built-in
   * registration: an object that merely calls itself PermissionBroker never
   * gets to answer here. Absent one, consequential actions are refused.
   */
  private async permissionBroker(): Promise<AbjectId | undefined> {
    if (this.permissionBrokerId) return this.permissionBrokerId;
    const id = await this.discoverDep('PermissionBroker').catch(() => null);
    if (!id || !(await this.isBuiltInCaller(id, ['PermissionBroker']))) return undefined;
    this.permissionBrokerId = id;
    return id;
  }

  /** What an action on the element a locator resolves to would do. */
  private async locatorVerdict(locator: PlaywrightLocator, kind: ActionKind, mark?: string): Promise<ActionVerdict | null> {
    return await locator.evaluate(classifyAction, { kind, mark }) as ActionVerdict | null;
  }

  /**
   * What a key would do to whatever has keyboard focus, in whichever frame
   * holds it (shadow roots included). Null when focus is on nothing.
   */
  private async focusedVerdict(page: PlaywrightPage, kind: ActionKind): Promise<ActionVerdict | null> {
    const script = `(() => {
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null;
      return { focus: document.hasFocus(), verdict: (${CLASSIFY_ACTION_SOURCE})(el, ${JSON.stringify({ kind })}) };
    })()`;
    let unfocused: ActionVerdict | null = null;
    for (const frame of page.frames()) {
      const r = await frame.evaluate(script).catch(() => null) as { focus: boolean; verdict: ActionVerdict | null } | null;
      if (!r?.verdict) continue;
      if (r.focus) return r.verdict;
      unfocused ??= r.verdict;
    }
    return unfocused;
  }

  /**
   * What a click at a viewport point would do. A point over a frame is
   * followed into it (up to a few levels), since that is where the click
   * lands; a frame that cannot be entered counts as consequential, because
   * nobody can see what it holds.
   */
  private async pointVerdict(page: PlaywrightPage, x: number, y: number): Promise<ActionVerdict | null> {
    let frame = page.mainFrame();
    let px = x;
    let py = y;
    for (let depth = 0; depth < 4; depth++) {
      const token = randomUUID();
      const hit = await frame.evaluate(`(() => {
        const el = document.elementFromPoint(${px}, ${py});
        if (!el) return null;
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          const b = el.getBoundingClientRect();
          el.setAttribute('data-abjects-probe', ${JSON.stringify(token)});
          return { frame: true, x: ${px} - b.left - el.clientLeft, y: ${py} - b.top - el.clientTop, src: el.src || '' };
        }
        return { verdict: (${CLASSIFY_ACTION_SOURCE})(el, { kind: 'click' }) };
      })()`).catch(() => null) as { verdict?: ActionVerdict | null; frame?: boolean; x?: number; y?: number; src?: string } | null;
      if (!hit) return null;
      if (!hit.frame) return hit.verdict ?? null;

      let inner: PlaywrightFrame | undefined;
      for (const child of frame.childFrames()) {
        const handle = await child.frameElement().catch(() => undefined);
        const probe = handle ? await handle.getAttribute('data-abjects-probe').catch(() => null) : null;
        await handle?.dispose().catch(() => {});
        if (probe === token) { inner = child; break; }
      }
      await frame.evaluate(`document.querySelectorAll('[data-abjects-probe]').forEach((e) => e.removeAttribute('data-abjects-probe'))`).catch(() => {});
      if (!inner) {
        return { consequential: true, action: 'click inside an embedded frame', effect: 'what the frame holds cannot be seen',
          control: 'frame', url: hit.src || frame.url() };
      }
      frame = inner;
      px = Number(hit.x);
      py = Number(hit.y);
    }
    return { consequential: true, action: 'click inside nested embedded frames', effect: 'what the frames hold cannot be seen',
      control: 'frame', url: frame.url() };
  }

  /**
   * Ask about a marked element, then act on exactly that element. A page that
   * re-rendered while the person decided must not turn their yes into a click
   * on a different control under the same selector; a vanished mark ends the
   * action instead.
   */
  private async actOnMarked(
    page: PlaywrightPage,
    requesterId: AbjectId,
    verdict: ActionVerdict,
    mark: string,
    act: (selector: string) => Promise<void>,
  ): Promise<void> {
    const selector = `[data-abjects-consent="${mark}"]`;
    try {
      await this.requireConsent(requesterId, verdict);
      if (await page.locator(selector).count() === 0) {
        throw new Error('The control changed while waiting for approval; look at the page again before acting');
      }
      await act(selector);
    } finally {
      await page.evaluate(`document.querySelectorAll('[data-abjects-consent="${mark}"]').forEach((e) => e.removeAttribute('data-abjects-consent'))`)
        .catch(() => { /* navigated away: the mark went with the document */ });
    }
  }

  /**
   * Run a caller's page script with consequential DOM calls held for the
   * person.
   *
   * A script is how an agent reads a page, and also the easiest way around
   * every check above: `button.click()` or `form.submit()` in a loop. While
   * the script runs, element.click(), form.submit(), form.requestSubmit() and
   * a dispatched click, submit or Enter are judged like any other action; the
   * first consequential one is held (it throws inside the script, so neither
   * it nor anything after it runs), and the script's guard is removed. Then
   * the held action alone goes to PermissionBroker. Approved, exactly that
   * one runs; declined, the call fails with the refusal. Nothing is re-run,
   * so one yes never becomes five clicks. Reads and ordinary DOM edits pass
   * untouched; a direct fetch from the script is not seen here.
   */
  private async evaluateGuarded(page: PlaywrightPage, requesterId: AbjectId, script: string): Promise<unknown> {
    await page.evaluate(this.guardScript('install'));
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      result = await this.evaluateScript(page, script);
    } catch (err) {
      failed = true;
      failure = err;
    }
    const held = await page.evaluate(this.guardScript('finish')).catch(() => null) as ActionVerdict | null;
    if (held?.consequential) {
      try {
        await this.requireConsent(requesterId, held);
      } catch (err) {
        await page.evaluate(this.guardScript('discard')).catch(() => {});
        throw err;
      }
      const ran = await page.evaluate(this.guardScript('perform'))
        .then(() => ({ performed: true }), (err: unknown) => ({ performed: false, error: err instanceof Error ? err.message : String(err) }));
      return {
        stoppedAt: held.action,
        site: siteOf(held.url),
        ...ran,
        note: 'The script stopped at this action to wait for the person. They approved it and it ran; the rest of the script did not run.',
      };
    }
    if (failed) throw failure;
    return result;
  }

  /**
   * The page-side steps of evaluateGuarded. Prototypes are patched only for
   * the script's run and restored after it, so the page's own code and its
   * fingerprinting checks see native methods the rest of the time.
   */
  private guardScript(step: 'install' | 'finish' | 'perform' | 'discard'): string {
    const key = JSON.stringify(this.guardKey);
    switch (step) {
      case 'install':
        return `(() => {
          const KEY = ${key};
          if (window[KEY]) { try { window[KEY].restore(); } catch (e) {} delete window[KEY]; }
          const classify = ${CLASSIFY_ACTION_SOURCE};
          const P = HTMLElement.prototype, F = HTMLFormElement.prototype, E = EventTarget.prototype;
          const orig = { click: P.click, submit: F.submit, requestSubmit: F.requestSubmit, dispatchEvent: E.dispatchEvent };
          const g = { held: null, perform: null, restore: null };
          const hold = (el, kind, perform) => {
            if (g.held) throw new Error('Held for the person to approve: ' + g.held.action);
            let v = null;
            try { v = classify(el, { kind }); } catch (e) { v = null; }
            if (!v || !v.consequential) return;
            g.held = v;
            g.perform = perform;
            throw new Error('Held for the person to approve: ' + v.action);
          };
          P.click = function () { hold(this, 'click', () => orig.click.call(this)); return orig.click.call(this); };
          F.submit = function () { hold(this, 'submit', () => orig.submit.call(this)); return orig.submit.call(this); };
          if (orig.requestSubmit) {
            F.requestSubmit = function (s) {
              hold(s || this, s ? 'click' : 'submit', () => orig.requestSubmit.call(this, s));
              return orig.requestSubmit.call(this, s);
            };
          }
          E.dispatchEvent = function (ev) {
            if (ev && this instanceof Element) {
              const t = ev.type;
              if (t === 'click') hold(this, 'click', () => orig.dispatchEvent.call(this, ev));
              else if (t === 'submit' && this instanceof HTMLFormElement) hold(this, 'submit', () => orig.dispatchEvent.call(this, ev));
              else if ((t === 'keydown' || t === 'keypress') && ev.key === 'Enter') hold(this, 'enter', () => orig.dispatchEvent.call(this, ev));
            }
            return orig.dispatchEvent.call(this, ev);
          };
          g.restore = () => {
            P.click = orig.click; F.submit = orig.submit; E.dispatchEvent = orig.dispatchEvent;
            if (orig.requestSubmit) F.requestSubmit = orig.requestSubmit;
          };
          Object.defineProperty(window, KEY, { value: g, configurable: true, enumerable: false });
          return true;
        })()`;
      case 'finish':
        return `(() => {
          const g = window[${key}];
          if (!g) return null;
          g.restore();
          if (!g.held) { delete window[${key}]; return null; }
          return g.held;
        })()`;
      case 'perform':
        return `(() => {
          const g = window[${key}];
          delete window[${key}];
          if (!g || !g.perform) throw new Error('The held action is gone (the page changed)');
          g.perform();
          return true;
        })()`;
      case 'discard':
        return `(() => { delete window[${key}]; return true; })()`;
    }
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
    // A click that submits or activates something waits for the person
    // (requireConsent); a link, a field, a menu opener goes straight through.
    this.deferredPageHandler('click', async (tracked, payload, msg) => {
      const selector = payload.selector as string;
      requireContract(typeof selector === 'string' && selector.length > 0, 'click needs a selector');
      const options = payload.options as Record<string, unknown> | undefined;
      const t0 = Date.now();
      const mark = randomUUID();
      const verdict = await this.locatorVerdict(tracked.page.locator(selector).first(), 'click', mark);
      if (verdict?.consequential) {
        await this.actOnMarked(tracked.page, msg.routing.from, verdict, mark, (marked) => tracked.page.click(marked, options));
      } else {
        await tracked.page.click(selector, options);
      }
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
    // Typing is never asked about, except a line break, which presses Enter:
    // in a form's field that submits the form.
    this.deferredPageHandler('type', async (tracked, payload, msg) => {
      const t0 = Date.now();
      const selector = payload.selector as string;
      const text = payload.text as string;
      requireContract(typeof selector === 'string' && selector.length > 0 && typeof text === 'string', 'type needs a selector and text');
      const mark = randomUUID();
      const verdict = /[\r\n]/.test(text)
        ? await this.locatorVerdict(tracked.page.locator(selector).first(), 'enter', mark)
        : null;
      if (verdict?.consequential) {
        await this.actOnMarked(tracked.page, msg.routing.from, verdict, mark, (marked) => tracked.page.type(marked, text));
      } else {
        await tracked.page.type(selector, text);
      }
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
    // Enter in a form's field submits it and Enter/Space on a button activates
    // it, so those wait for the person; every other key goes straight through.
    this.deferredPageHandler('press', async (tracked, payload, msg) => {
      const t0 = Date.now();
      const key = payload.key as string;
      requireContract(typeof key === 'string' && key.length > 0, 'press needs a key');
      const kind = keyKind(key);
      const verdict = kind ? await this.focusedVerdict(tracked.page, kind) : null;
      if (verdict?.consequential) {
        await this.requireConsent(msg.routing.from, verdict);
        if (!sameControl(verdict, await this.focusedVerdict(tracked.page, kind!))) {
          throw new Error('Keyboard focus moved while waiting for approval; look at the page again before pressing');
        }
      }
      await tracked.page.keyboard.press(key);
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
      const options = payload.options as { fullPage?: boolean; scale?: 'css' | 'device' } | undefined;
      requireContract(options?.scale === undefined || options.scale === 'css' || options.scale === 'device',
        "screenshotPage scale must be 'css' or 'device'");
      const buffer = await tracked.page.screenshot({
        type: 'png',
        fullPage: options?.fullPage ?? false,
        ...(options?.scale ? { scale: options.scale } : {}),
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
    // `generation` names the document the refs were taken from; refAction
    // takes it back to check the refs still apply.
    this.deferredPageHandler('getAriaSnapshot', async (tracked) => {
      const t0 = Date.now();
      const before = await this.documentId(tracked.page);
      const url = tracked.page.url();
      const title = await this.safeTitle(tracked.page, url);
      const result = await tracked.page._snapshotForAI({ track: 'response' });
      const generation = await this.documentId(tracked.page);
      if (generation !== before) throw new Error('Page navigated while observing; request a fresh snapshot');
      log.info(`getAriaSnapshot (url=${url}) [${Date.now() - t0}ms]`);
      return { snapshot: result.full, url, title, generation };
    });

    // -- refAction --
    this.deferredPageHandler('refAction', async (tracked, payload, msg) => {
      if (payload.expectedGeneration !== undefined
        && payload.expectedGeneration !== await this.documentId(tracked.page)) {
        throw new Error('Page navigated since observation; get a fresh snapshot before acting');
      }
      const ref = payload.ref as string;
      const action = payload.action as string;
      const value = payload.value as string | undefined;
      const t0 = Date.now();

      const locator = tracked.page.locator(`aria-ref=${ref}`);
      // A ref the page no longer has (re-rendered away, or inside a frame that
      // navigated) would otherwise sit in Playwright's auto-wait past the
      // caller's request timeout, and then fire late on whatever is there.
      if (await locator.count() === 0) {
        throw new Error(`Ref ${ref} is no longer on the page; get a fresh snapshot before acting`);
      }
      // The snapshot also names elements nobody can reach: a collapsed menu's
      // items, a duplicate of a button parked off the page for keyboard
      // shortcuts or screen readers. Acting on one waits out the timeout;
      // say so at once instead.
      if (WebBrowser.NEEDS_VISIBLE.has(action)) {
        if (!(await locator.isVisible())) {
          throw new Error(`Ref ${ref} is on the page but not visible (hidden, collapsed, or zero-size); open what contains it, pick a visible element with the same name, or use the pointer on the screenshot`);
        }
        const offPage = await locator.evaluate((el: Element) => {
          const r = el.getBoundingClientRect();
          return r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0;
        }).catch(() => false);
        if (offPage) {
          throw new Error(`Ref ${ref} is parked off the page where no one can reach it (often a hidden duplicate); pick a visible element with the same name, or use the pointer on the screenshot`);
        }
      }
      const opts = { timeout: WebBrowser.REF_ACTION_TIMEOUT_MS };

      // A click, an activating key, or a line break typed into a form's field
      // waits for the person when it would submit or activate something. The
      // ref names one element, so the answer applies to exactly that element;
      // if it (or the document) went away meanwhile, the action stops there.
      const kind: ActionKind | undefined = action === 'click' ? 'click'
        : action === 'press' ? keyKind(value ?? '')
        : action === 'type' && /[\r\n]/.test(value ?? '') ? 'enter' : undefined;
      const verdict = kind ? await this.locatorVerdict(locator, kind) : null;
      if (verdict?.consequential) {
        await this.requireConsent(msg.routing.from, verdict);
        if (payload.expectedGeneration !== undefined
          && payload.expectedGeneration !== await this.documentId(tracked.page)) {
          throw new Error('Page navigated while waiting for approval; get a fresh snapshot before acting');
        }
        if (await locator.count() === 0) {
          throw new Error(`Ref ${ref} left the page while waiting for approval; get a fresh snapshot before acting`);
        }
      }

      switch (action) {
        case 'click':
          await locator.click(opts);
          break;
        case 'fill':
          await locator.fill(value ?? '', opts);
          break;
        case 'type':
          await locator.type(value ?? '', opts);
          break;
        case 'hover':
          await locator.hover(opts);
          break;
        case 'check':
          await locator.check(opts);
          break;
        case 'uncheck':
          await locator.uncheck(opts);
          break;
        case 'selectOption':
          await locator.selectOption(value ? { label: value } : '', opts);
          break;
        case 'press':
          await locator.press(value ?? '', opts);
          break;
        default:
          throw new Error(`Unknown ref action: ${action}`);
      }

      log.info(`refAction (${payload.pageId}) ${action} ref=${ref} [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- evaluate --
    // Consequential DOM calls the script makes are held for the person
    // (evaluateGuarded); everything else runs as written.
    this.deferredPageHandler('evaluate', async (tracked, payload, msg) => {
      const t0 = Date.now();
      requireContract(typeof payload.script === 'string', 'evaluate needs a script');
      const result = await this.evaluateGuarded(tracked.page, msg.routing.from, (payload.script as string).trim());
      log.info(`evaluate (${payload.pageId}) [${Date.now() - t0}ms]`);
      return { result };
    });

    // -- Pointer and keyboard: real input at viewport CSS-pixel coordinates --
    // The same trusted input path a person's mouse takes, for what the
    // accessibility snapshot cannot name: unlabeled tiles, icon buttons,
    // canvas, custom widgets. Each reports what it landed on, so a caller
    // aiming from a screenshot can tell a hit from a near miss.
    this.deferredPageHandler('clickAt', async (tracked, payload, msg) => {
      const { x, y } = WebBrowser.requirePoint(payload.x, payload.y);
      const button = WebBrowser.requireButton(payload.button);
      const clickCount = payload.clickCount === undefined ? 1 : Number(payload.clickCount);
      requireContract([1, 2, 3].includes(clickCount), 'clickAt clickCount must be 1, 2 or 3');
      // Only the left button activates; the others open menus or new tabs.
      const verdict = button === 'left' ? await this.pointVerdict(tracked.page, x, y) : null;
      if (verdict?.consequential) {
        await this.requireConsent(msg.routing.from, clickCount > 1
          ? { ...verdict, action: `${verdict.action} (${clickCount} clicks)` } : verdict);
        if (!sameControl(verdict, await this.pointVerdict(tracked.page, x, y))) {
          throw new Error('The page changed under the pointer while waiting for approval; look again before clicking');
        }
      }
      const target = await this.elementAt(tracked.page, x, y);
      await tracked.page.mouse.click(x, y, { button, clickCount });
      tracked.lastActivity = Date.now();
      log.info(`clickAt (${payload.pageId}) ${x},${y} ${button}x${clickCount} → ${target?.tag ?? 'nothing'}`);
      return { target };
    });

    this.deferredPageHandler('hoverAt', async (tracked, payload) => {
      const { x, y } = WebBrowser.requirePoint(payload.x, payload.y);
      const target = await this.elementAt(tracked.page, x, y);
      await tracked.page.mouse.move(x, y, { steps: 5 });
      tracked.lastActivity = Date.now();
      return { target };
    });

    this.deferredPageHandler('drag', async (tracked, payload, msg) => {
      const from = WebBrowser.requirePoint(payload.fromX, payload.fromY);
      const to = WebBrowser.requirePoint(payload.toX, payload.toY);
      // Pressed and released on the same button is a click on it.
      const pressed = await this.pointVerdict(tracked.page, from.x, from.y);
      if (pressed?.consequential && sameControl(pressed, await this.pointVerdict(tracked.page, to.x, to.y))) {
        await this.requireConsent(msg.routing.from, pressed);
      }
      const fromTarget = await this.elementAt(tracked.page, from.x, from.y);
      const mouse = tracked.page.mouse;
      await mouse.move(from.x, from.y, { steps: 5 });
      await mouse.down({ button: 'left' });
      // Many small moves: sliders and drop targets track the path, not the jump.
      await mouse.move(to.x, to.y, { steps: 20 });
      await mouse.up({ button: 'left' });
      const toTarget = await this.elementAt(tracked.page, to.x, to.y);
      tracked.lastActivity = Date.now();
      log.info(`drag (${payload.pageId}) ${from.x},${from.y} → ${to.x},${to.y}`);
      return { from: fromTarget, to: toTarget };
    });

    this.deferredPageHandler('scroll', async (tracked, payload) => {
      const deltaY = Number(payload.deltaY ?? 0);
      const deltaX = Number(payload.deltaX ?? 0);
      requireContract(Number.isFinite(deltaY) && Number.isFinite(deltaX), 'scroll needs numeric deltaY/deltaX');
      const viewport = this.safeViewportSize(tracked.page);
      const at = payload.x === undefined && payload.y === undefined
        ? { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
        : WebBrowser.requirePoint(payload.x, payload.y);
      await tracked.page.mouse.move(at.x, at.y);
      await tracked.page.mouse.wheel(deltaX, deltaY);
      // Smooth scrolling and lazy-loaded rows land a beat after the wheel.
      await new Promise(resolve => setTimeout(resolve, 400));
      tracked.lastActivity = Date.now();
      const position = await tracked.page.evaluate(`(() => {
        const s = document.scrollingElement || document.documentElement;
        return { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), maxScrollY: Math.max(0, Math.round(s.scrollHeight - innerHeight)) };
      })()`).catch(() => ({ scrollX: 0, scrollY: 0, maxScrollY: 0 }));
      return position;
    });

    this.deferredPageHandler('typeText', async (tracked, payload, msg) => {
      const text = payload.text;
      requireContract(typeof text === 'string' && text.length > 0, 'typeText needs non-empty text');
      // Keystrokes with no field focused go to the page itself, where many
      // sites bind single keys to actions (archive, delete, next). Typing is
      // for a field; a deliberate shortcut is a press.
      if (!(await tracked.page.evaluate(WebBrowser.EDITABLE_FOCUS_SCRIPT).catch(() => false))) {
        throw new Error('Nothing editable has keyboard focus; click the field first (keys meant as shortcuts go through press)');
      }
      // Typed key by key, a line break is an Enter press, which submits a
      // form's field; that waits for the person. (A long body is inserted as
      // text, where a line break is only a line break.)
      if (text.length <= WebBrowser.KEY_BY_KEY_MAX_CHARS && /[\r\n]/.test(text)) {
        const verdict = await this.focusedVerdict(tracked.page, 'enter');
        if (verdict?.consequential) {
          await this.requireConsent(msg.routing.from, verdict);
          if (!sameControl(verdict, await this.focusedVerdict(tracked.page, 'enter'))) {
            throw new Error('Keyboard focus moved while waiting for approval; look at the page again before typing');
          }
        }
      }
      // Key-by-key fires every listener a person's typing would (autocomplete,
      // validation); a long body goes in as one insertion so it is not slow.
      if (text.length <= WebBrowser.KEY_BY_KEY_MAX_CHARS) await tracked.page.keyboard.type(text);
      else await tracked.page.keyboard.insertText(text);
      tracked.lastActivity = Date.now();
      const focused = await this.describeElement(tracked.page, 'document.activeElement');
      return { focused };
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

    // -- viewerFrame: no ownership check — the change-driven viewer transport --
    //
    // One poll of the live view. The capture is compared here, in the process
    // that took it, against the frame this page's client already holds: a still
    // page costs nothing on the bus, a moving page sends only the rectangles
    // that differ, and a whole key frame goes out on the first poll, on a size
    // change, when the client asks for one, or once the key-frame interval has
    // elapsed so a client that fell behind can catch up.
    this.on('viewerFrame', (msg: AbjectMessage) => {
      const { pageId, options } = msg.payload as {
        pageId: string; options?: ViewerFrameOptions;
      };
      requireContract(typeof pageId === 'string' && pageId.length > 0,
        'viewerFrame requires a pageId');
      const tracked = this.pages.get(pageId);
      if (!tracked) {
        this.send(error(msg, 'BROWSER_ERROR', `Unknown page handle: ${pageId}`));
        return DEFERRED_REPLY;
      }
      tracked.page.screenshot({ type: 'png', fullPage: false })
        .then(async (buffer: Buffer) => {
          const reply = this.nextViewerFrame(pageId, decodePng(buffer), options);
          const url = tracked.page.url();
          const title = await this.safeTitle(tracked.page, url);
          this.sendDeferredReply(msg, { ...reply, url, title });
        })
        .catch((err: unknown) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        });
      return DEFERRED_REPLY;
    });

    // -- viewerVideoFrame: no ownership check — the codec transport --
    //
    // One poll of the live view as video. The capture is encoded to VP8 here,
    // next to the pixels: a still page sends nothing at all, a moving page
    // sends one small inter frame per poll, and the browser decodes the
    // stream with WebCodecs. This replaces the PNG patch/key-frame transport,
    // whose asynchronous reassembly of rectangles is what flickered.
    this.on('viewerVideoFrame', (msg: AbjectMessage) => {
      const { pageId, options } = msg.payload as {
        pageId: string;
        options?: { forceKey?: boolean; keyFrameIntervalMs?: number };
      };
      requireContract(typeof pageId === 'string' && pageId.length > 0,
        'viewerVideoFrame requires a pageId');
      const tracked = this.pages.get(pageId);
      if (!tracked) {
        this.send(error(msg, 'BROWSER_ERROR', `Unknown page handle: ${pageId}`));
        return DEFERRED_REPLY;
      }
      tracked.page.screenshot({ type: 'png', fullPage: false })
        .then(async (buffer: Buffer) => {
          const reply = await this.nextViewerVideoFrame(pageId, decodePng(buffer), options);
          const url = tracked.page.url();
          const title = await this.safeTitle(tracked.page, url);
          this.sendDeferredReply(msg, { ...reply, url, title });
        })
        .catch((err: unknown) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        });
      return DEFERRED_REPLY;
    });

    // -- viewerFrameStats: no ownership check — what the transport has sent --
    this.on('viewerFrameStats', (msg: AbjectMessage) => {
      const { pageId } = msg.payload as { pageId?: string };
      const ids = pageId ? [pageId] : [...this.viewerSessions.keys()];
      const pages = ids.map((id) => this.viewerFrameStatsFor(id));
      const totals = {
        framesServed: 0, unchangedTicks: 0, keyFrames: 0,
        deltas: 0, patches: 0, bytesSent: 0,
      };
      for (const page of pages) {
        totals.framesServed += page.framesServed;
        totals.unchangedTicks += page.unchangedTicks;
        totals.keyFrames += page.keyFrames;
        totals.deltas += page.deltas;
        totals.patches += page.patches;
        totals.bytesSent += page.bytesSent;
      }
      return {
        pages,
        pollMs: this.viewerPollMs,
        keyFrameIntervalMs: this.viewerKeyFrameIntervalMs,
        totals,
      };
    });

    // -- configureViewerFrame: no ownership check — the cadences are tunable --
    this.on('configureViewerFrame', (msg: AbjectMessage) => {
      const { pollMs, keyFrameIntervalMs } = msg.payload as {
        pollMs?: number; keyFrameIntervalMs?: number;
      };
      if (pollMs !== undefined) {
        requireContract(Number.isFinite(pollMs) && pollMs >= 0,
          'configureViewerFrame pollMs must be a non-negative number');
        this.viewerPollMs = pollMs;
      }
      if (keyFrameIntervalMs !== undefined) {
        requireContract(Number.isFinite(keyFrameIntervalMs) && keyFrameIntervalMs >= 0,
          'configureViewerFrame keyFrameIntervalMs must be a non-negative number');
        this.viewerKeyFrameIntervalMs = keyFrameIntervalMs;
        for (const session of this.viewerSessions.values()) {
          session.setKeyFrameInterval(keyFrameIntervalMs);
        }
      }
      return {
        pollMs: this.viewerPollMs,
        keyFrameIntervalMs: this.viewerKeyFrameIntervalMs,
      };
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

    // -- viewerClosePage: no ownership check — the person closing a tab --
    //
    // The viewer's tabs come from listPages, which lists every open page, so a
    // tab is usually another object's page (an agent's automation page). The
    // owner check in closePage stays: an agent closing its own page is a
    // different act from the person closing a tab. Sending the tab close
    // through closePage made it fail "Page X is owned by ..., not ..." and the
    // viewer's catch hid the refusal, so the page never closed. A person
    // closing the tab is the person's own decision, so it is admitted here on
    // being the built-in viewer, exactly as viewerInput is.
    this.on('viewerClosePage', (msg: AbjectMessage) => {
      const { pageId } = msg.payload as { pageId: string };
      requireContract(typeof pageId === 'string' && pageId.length > 0,
        'viewerClosePage requires a pageId');
      const tracked = this.pages.get(pageId);
      if (!tracked) {
        this.send(error(msg, 'BROWSER_ERROR', `Unknown page handle: ${pageId}`));
        return DEFERRED_REPLY;
      }
      this.isBuiltInCaller(msg.routing.from, ['WebBrowserViewer']).then(async (viewer) => {
        if (!viewer) throw new PermissionDenied({
          authority: this.id, callerId: msg.routing.from, operation: 'viewerClosePage', resource: pageId,
          decision: 'deny', source: 'policy', reason: 'closing another object\'s page is taken only from the built-in WebBrowserViewer',
        }, 'viewerClosePage is taken only from WebBrowserViewer; close your own page with closePage');
        this.releasePage(pageId);
        try { await tracked.page.close(); } catch { /* already closed */ }
        this.changed('pageClosed', { pageId });
        return { success: true };
      }).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          if (err instanceof PermissionDenied) {
            this.send(error(msg, err.code, err.message, err.details));
            return;
          }
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
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
      // This is the person's own mouse and keyboard, so it is never asked
      // about; that is exactly why only the built-in viewer may send it.
      // Anything else would be a way around every consent check above.
      this.isBuiltInCaller(msg.routing.from, ['WebBrowserViewer']).then((viewer) => {
        if (!viewer) throw new PermissionDenied({
          authority: this.id, callerId: msg.routing.from, operation: 'viewerInput', resource: pageId,
          decision: 'deny', source: 'policy', reason: 'raw input is taken only from the built-in WebBrowserViewer',
        }, 'viewerInput is the person\'s takeover channel and is taken only from WebBrowserViewer; act on the page with click, press, clickAt or typeText');
        return this.dispatchViewerInput(tracked, events);
      }).then(
        (dispatched) => this.sendDeferredReply(msg, { dispatched }),
        (err) => {
          if (err instanceof PermissionDenied) {
            this.send(error(msg, err.code, err.message, err.details));
            return;
          }
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
   * How long a ref action may wait for its element to become actionable.
   * Under the callers' 30s request timeout, so an action that cannot happen
   * fails while the caller is still listening instead of landing after it
   * has moved on.
   */
  private static readonly REF_ACTION_TIMEOUT_MS = 15_000;

  /** Ref actions that need an element a person could see and reach. */
  private static readonly NEEDS_VISIBLE = new Set(['click', 'hover', 'check', 'uncheck', 'fill', 'type']);

  /** Whether keyboard focus is on something that takes text (open shadow roots and iframes included). */
  private static readonly EDITABLE_FOCUS_SCRIPT = `(() => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.tagName === 'IFRAME' || el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes((el.type || '').toLowerCase());
    return ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(el.getAttribute('role') || '');
  })()`;

  /** typeText sends text up to this long key by key, longer text as one insertion. */
  private static readonly KEY_BY_KEY_MAX_CHARS = 300;

  /** A viewport point in CSS pixels, required finite and non-negative. */
  private static requirePoint(x: unknown, y: unknown): { x: number; y: number } {
    const px = Number(x);
    const py = Number(y);
    requireContract(Number.isFinite(px) && Number.isFinite(py) && px >= 0 && py >= 0,
      `A point needs non-negative numeric x and y (got ${String(x)}, ${String(y)})`);
    return { x: px, y: py };
  }

  private static requireButton(button: unknown): 'left' | 'right' | 'middle' {
    const b = button === undefined ? 'left' : button;
    requireContract(b === 'left' || b === 'right' || b === 'middle', "button must be 'left', 'right' or 'middle'");
    return b as 'left' | 'right' | 'middle';
  }

  /** What is at a viewport point: the actionable element containing the hit. */
  private elementAt(page: PlaywrightPage, x: number, y: number): Promise<PointTarget | null> {
    return this.describeElement(page, `document.elementFromPoint(${x}, ${y})`);
  }

  /**
   * A short description of an element: the nearest actionable ancestor's tag,
   * role, and the name a person would read on it. A field's typed value is
   * left out (it may be a password).
   */
  private async describeElement(page: PlaywrightPage, elementExpr: string): Promise<PointTarget | null> {
    try {
      return await page.evaluate(`(() => {
        const el = ${elementExpr};
        if (!el || el === document.body || el === document.documentElement) return null;
        const hit = el.closest('a,button,input,select,textarea,label,summary,option,[role],[onclick],[tabindex],[contenteditable="true"],[contenteditable=""]') || el;
        const tag = hit.tagName.toLowerCase();
        const field = tag === 'input' || tag === 'textarea' || tag === 'select';
        const name = hit.getAttribute('aria-label') || hit.getAttribute('title') || hit.getAttribute('alt')
          || hit.getAttribute('placeholder') || (field ? hit.getAttribute('name') : hit.innerText) || '';
        const out = { tag };
        const role = hit.getAttribute('role'); if (role) out.role = role;
        const type = hit.getAttribute('type'); if (type) out.type = type;
        const text = String(name).replace(/\s+/g, ' ').trim().slice(0, 80); if (text) out.text = text;
        return out;
      })()`) as PointTarget | null;
    } catch {
      return null;
    }
  }

  /**
   * Identity of the document a page is showing: its time origin. Every new
   * document gets a fresh one; same-document navigation (history.pushState,
   * a #hash) and anything happening in iframes keep it. Snapshot refs live
   * in the document they were taken from, so this is exactly when they stop
   * applying. (A navigation counter also counted single-page-app route
   * changes and every iframe load, which on a busy site made almost every
   * ref "stale".) A page with no document to ask, mid-navigation, reads as
   * a different document (NaN equals nothing).
   */
  private async documentId(page: PlaywrightPage): Promise<number> {
    try {
      return await page.evaluate('performance.timeOrigin') as number;
    } catch {
      return NaN;
    }
  }

  /**
   * Run a caller's script and return its value, awaited. The script runs as
   * written first, which covers expressions, IIFEs (an async one is awaited)
   * and statement lists. Only a script that is not valid that way because it
   * has a top-level `return` or `await` runs again as an async function body.
   * Wrapping on the mere presence of the word `return` used to swallow the
   * value of every IIFE or callback that contained one.
   */
  private async evaluateScript(page: PlaywrightPage, script: string): Promise<unknown> {
    try {
      return await page.evaluate(script);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/SyntaxError: (Illegal return statement|await is only valid in async functions)/.test(message)) throw err;
      return page.evaluate(`(async () => {\n${script}\n})()`);
    }
  }

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
    await WebBrowser.keepOffOwnDesktop(page);
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
    // Its reference frame goes with it: a new page with the same handle must
    // not be diffed against the old page's pixels.
    this.viewerSessions.delete(pageId);
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
        this.viewerSessions.clear();
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
    const hostId = await this.windowHost();
    if (!hostId) return this.createLaunchedPage(callerId, options);

    // Inside the desktop app every page is an app window, headless or headful,
    // so one profile is one cookie jar. Only a browser channel the caller
    // names explicitly is launched separately, and an app window stands in if
    // that browser is not installed.
    if (!(options?.channel ?? process.env.ABJECTS_BROWSER_CHANNEL)) {
      return this.createElectronPage(hostId, callerId, options);
    }
    try {
      return await this.createLaunchedPage(callerId, options);
    } catch (err) {
      log.info(`channel launch failed, opening an app window instead: ${err instanceof Error ? err.message : String(err)}`);
      return this.createElectronPage(hostId, callerId, options);
    }
  }

  /** A page in a browser Playwright launched itself (always, outside the desktop app). */
  private async createLaunchedPage(callerId: AbjectId, options?: BrowseOptions): Promise<unknown> {
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

  // ===========================================================================
  // Desktop app: pages in Electron's own Chromium
  // ===========================================================================

  /**
   * BrowserWindowHost's id when running inside the desktop app, otherwise
   * undefined. Outside Electron the registry is never asked.
   */
  private async windowHost(): Promise<AbjectId | undefined> {
    if (!process.env.ELECTRON_PACKAGED) return undefined;
    this.windowHostId = await this.resolveDep('BrowserWindowHost', this.windowHostId);
    return this.windowHostId;
  }

  /** Connect Playwright to the app's Chromium once, and again after a disconnect. */
  private ensureElectronBrowser(hostId: AbjectId): Promise<CdpBrowser> {
    if (!this.electronBrowser) {
      const connecting = (async () => {
        const { endpoint } = await this.request<{ endpoint: string }>(
          request(this.id, hostId, 'getCdpEndpoint', {}));
        const pw = await import('playwright');
        const browser = await pw.chromium.connectOverCDP(endpoint) as unknown as CdpBrowser;
        browser.on('disconnected', () => {
          if (this.electronBrowser === connecting) this.electronBrowser = null;
        });
        log.info(`attached to the app's Chromium at ${endpoint}`);
        return browser;
      })();
      connecting.catch(() => {
        if (this.electronBrowser === connecting) this.electronBrowser = null;
      });
      this.electronBrowser = connecting;
    }
    return this.electronBrowser;
  }

  /**
   * Open a page as an app window: the host creates the window at
   * about:blank#<token>, and the page is found over CDP by that token. The
   * token is also what tells these pages apart from the app's own window,
   * which the CDP connection sees too.
   */
  private async createElectronPage(
    hostId: AbjectId,
    callerId: AbjectId,
    options?: BrowseOptions,
  ): Promise<PlaywrightPage> {
    const browser = await this.ensureElectronBrowser(hostId);
    const sessionPath = options?.profile
      ? await this.electronProfileSession(callerId, options.profile)
      : undefined;
    const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
    const token = `abjects-page-${randomUUID()}`;
    try {
      await this.request(request(this.id, hostId, 'createWindow', {
        token,
        sessionPath,
        headful: !this.browserHeadless(options),
        viewport,
        userAgent: options?.userAgent,
      }));
    } catch (err) {
      // A host the Supervisor restarted has a new id; look it up afresh next time.
      if (this.windowHostId === hostId) this.windowHostId = undefined;
      throw err;
    }

    let page: PlaywrightPage;
    try {
      page = await this.findElectronPage(browser, token);
      // Fix the layout viewport as a launched browser does, so viewport
      // reads, screenshots and viewer coordinates agree whatever the window.
      await page.setViewportSize(viewport);
    } catch (err) {
      this.closeElectronWindow(hostId, token);
      throw err;
    }
    // However the page ends (closed here, closed by the user, connection
    // lost), its window goes with it.
    page.on('close', () => this.closeElectronWindow(hostId, token));
    this.electronPages.add(page);
    return page;
  }

  /** The CDP page whose URL carries the token, once Playwright has attached to it. */
  private async findElectronPage(browser: CdpBrowser, token: string): Promise<PlaywrightPage> {
    const marker = `#${token}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (page.url().endsWith(marker)) return page;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`App window ${token} never appeared over CDP`);
  }

  private closeElectronWindow(hostId: AbjectId, token: string): void {
    this.request(request(this.id, hostId, 'closeWindow', { token })).catch(() => {
      /* host gone; its windows went with it */
    });
  }

  /**
   * On-disk session directory for a profile in the desktop app, recorded in
   * the same profile index the launched path uses.
   */
  private async electronProfileSession(callerId: AbjectId, profileName: string): Promise<string> {
    const wsId = await this.resolveCallerWorkspace(callerId);
    const safeName = this.sanitizeProfileName(profileName);
    requireContract(safeName.length > 0, `Invalid profile name: ${profileName}`);
    const key = `${wsId}/${safeName}`;
    const dir = path.join(this.profilesRoot, wsId, safeName);
    const sessionPath = path.join(dir, ELECTRON_SESSION_DIR);
    await fs.mkdir(sessionPath, { recursive: true });

    const now = Date.now();
    await this.writeProfileIndex(key, { workspaceId: wsId, name: safeName, dir, createdAt: now, lastUsed: now });
    if (!this.openedElectronProfiles.has(key)) {
      this.openedElectronProfiles.add(key);
      this.changed('profileOpened', { profile: safeName, workspaceId: wsId });
      log.info(`profile session ready: ${key} (${sessionPath})`);
    }
    return sessionPath;
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
   * Decide what one captured frame becomes for the viewer transport, keeping
   * the frame this page's client already holds as the reference: identical
   * pixels send nothing, a change sends only the differing rectangles, and the
   * first frame, a size change, a forced request or an elapsed key-frame
   * interval sends a whole frame.
   */
  /**
   * Encode one captured frame for the codec transport.
   *
   * A page whose pixels have not changed sends nothing: the frame is compared
   * against the one last encoded before any encoding cost is paid. Otherwise
   * the encoder emits one inter frame (a key frame on the first poll, after the
   * key-frame interval, on a size change, or when the client asks for one), and
   * those packets are the stream the browser decodes continuously.
   */
  private async nextViewerVideoFrame(
    pageId: string,
    frame: RgbaFrame,
    options?: { forceKey?: boolean; keyFrameIntervalMs?: number },
  ): Promise<ViewerVideoReply> {
    const interval = options?.keyFrameIntervalMs ?? this.viewerKeyFrameIntervalMs;
    const fitted = fitFrameToVideo(
      frame.data, frame.width, frame.height,
      VIEWER_VIDEO_MAX_WIDTH, VIEWER_VIDEO_MAX_HEIGHT,
    );
    const pixels = fitted.data instanceof Uint8Array ? fitted.data : new Uint8Array(fitted.data.buffer, fitted.data.byteOffset, fitted.data.byteLength);

    let stream = this.viewerVideoStreams.get(pageId);
    const sizeChanged = !!stream && (stream.width !== fitted.width || stream.height !== fitted.height);
    if (!stream || sizeChanged) {
      if (stream) await stream.encoder.close().catch(() => undefined);
      stream = {
        encoder: await Vp8Encoder.create({ width: fitted.width, height: fitted.height }),
        width: fitted.width,
        height: fitted.height,
        seq: 0,
        lastKeyAt: 0,
        lastFrame: new Uint8Array(0),
        keyFrames: 0,
        deltas: 0,
        unchangedTicks: 0,
        bytesSent: 0,
      };
      this.viewerVideoStreams.set(pageId, stream);
    } else if (!options?.forceKey && framesEqual(stream.lastFrame, pixels)) {
      stream.unchangedTicks += 1;
      return {
        kind: 'unchanged', seq: stream.seq, key: false,
        width: stream.width, height: stream.height,
        sourceWidth: frame.width, sourceHeight: frame.height,
        codec: VP8_CODEC, chunks: [],
      };
    }

    const now = Date.now();
    const dueForKey = stream.seq === 0 || options?.forceKey === true
      || sizeChanged || now - stream.lastKeyAt >= interval;
    const chunks = await stream.encoder.encode(pixels);
    const isKey = chunks.some((c) => c.type === 'key');
    if (!isKey && dueForKey) {
      // The encoder last emitted a key frame long enough ago; the client can
      // still recover because a key frame is always the first packet it gets.
      // Nothing to force here — libvpx decides — so record what happened.
    }
    stream.lastFrame = pixels;
    stream.seq += 1;
    if (isKey) { stream.keyFrames += 1; stream.lastKeyAt = now; } else { stream.deltas += 1; }
    const payload = chunks.map((c) => ({
      type: c.type,
      timestamp: c.timestamp,
      data: Buffer.from(c.data).toString('base64'),
    }));
    stream.bytesSent += chunks.reduce((n, c) => n + c.data.length, 0);
    return {
      kind: 'video', seq: stream.seq, key: isKey,
      width: stream.width, height: stream.height,
      sourceWidth: frame.width, sourceHeight: frame.height,
      codec: VP8_CODEC, chunks: payload,
    };
  }

  /** Counters for one page's codec transport. */
  private viewerVideoStatsFor(pageId: string): {
    pageId: string; width: number; height: number; seq: number;
    keyFrames: number; deltas: number; unchangedTicks: number; bytesSent: number;
  } {
    const stream = this.viewerVideoStreams.get(pageId);
    if (!stream) {
      return { pageId, width: 0, height: 0, seq: 0, keyFrames: 0, deltas: 0, unchangedTicks: 0, bytesSent: 0 };
    }
    return {
      pageId, width: stream.width, height: stream.height, seq: stream.seq,
      keyFrames: stream.keyFrames, deltas: stream.deltas,
      unchangedTicks: stream.unchangedTicks, bytesSent: stream.bytesSent,
    };
  }

  private nextViewerFrame(
    pageId: string, frame: RgbaFrame, options?: ViewerFrameOptions,
  ): ViewerFrameReply {
    let session = this.viewerSessions.get(pageId);
    if (!session) {
      session = new ViewerFrameSession({ keyFrameIntervalMs: this.viewerKeyFrameIntervalMs });
      this.viewerSessions.set(pageId, session);
    }
    return session.next(frame, Date.now(), options);
  }

  /** Counters for one page's viewer transport, readable from outside. */
  private viewerFrameStatsFor(pageId: string): {
    pageId: string; framesServed: number; unchangedTicks: number;
    keyFrames: number; deltas: number; patches: number;
    bytesSent: number; lastSeq: number; keyFrameIntervalMs: number;
  } {
    const session = this.viewerSessions.get(pageId);
    if (!session) {
      return {
        pageId, framesServed: 0, unchangedTicks: 0, keyFrames: 0, deltas: 0,
        patches: 0, bytesSent: 0, lastSeq: 0,
        keyFrameIntervalMs: this.viewerKeyFrameIntervalMs,
      };
    }
    const s = session.stats;
    return {
      pageId,
      framesServed: s.keyFrames + s.deltas,
      unchangedTicks: s.unchangedTicks,
      keyFrames: s.keyFrames,
      deltas: s.deltas,
      patches: s.patches,
      bytesSent: s.bytesSent,
      lastSeq: session.currentSeq,
      keyFrameIntervalMs: session.keyFrameInterval,
    };
  }

  /**
   * Keep a page off this instance's own desktop (isOwnDesktopUrl): every
   * request to it, from a navigation, a link, a redirect, a frame or script,
   * is aborted. A browser on the desktop's page is a desktop client: it sees
   * every window, private conversations included, and can type into them.
   */
  private static async keepOffOwnDesktop(page: unknown): Promise<void> {
    const routable = page as { route?: (match: (url: URL) => boolean, handler: (route: { abort: (code?: string) => Promise<void> }) => Promise<void>) => Promise<void> };
    if (typeof routable.route !== 'function') return;
    await routable.route(
      (url: URL) => isOwnDesktopUrl(url.href, process.env),
      async (route) => { await route.abort('blockedbyclient').catch(() => undefined); },
    );
  }

  /**
   * Navigate a page to a URL and wait for content.
   */
  private async navigatePage(
    page: Pick<PlaywrightPage, 'goto' | 'waitForSelector' | 'setContent'>,
    url: string,
    options?: BrowseOptions,
  ): Promise<void> {
    if (isOwnDesktopUrl(url, process.env)) {
      throw new Error(`${url} is this Abjects instance's own desktop, which the browser does not open: it shows the person's windows, private conversations included.`);
    }
    const timeout = options?.timeout ?? 30000;
    try {
      await page.goto(url, {
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
        timeout,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const announced = msg.includes('Download is starting');
      // An app window in the desktop app cancels downloads rather than raise a
      // save dialog, and Playwright reports that only as an aborted
      // navigation. Whether it was a download is read off the response.
      const cancelled = !announced && msg.includes('net::ERR_ABORTED') && this.electronPages.has(page);
      if (announced || cancelled) {
        // Non-HTML response (text/plain, application/octet-stream, etc.)
        // Fetch the content directly and inject it into the page as preformatted text
        log.info(`navigatePage: download triggered for ${url}, fetching content directly`);
        try {
          const resp = await fetch(url);
          if (cancelled && !WebBrowser.isDownloadResponse(resp)) throw err;
          const text = await resp.text();
          const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          await page.setContent(
            `<html><head><title>${url}</title></head><body><pre>${escaped}</pre></body></html>`
          );
        } catch (fetchErr) {
          if (fetchErr === err) throw err;
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

  /**
   * Whether Chromium would have downloaded this response rather than shown
   * it: an attachment, or a type it does not render. Anything else that
   * aborted a navigation (a 204, a navigation cut short by another) is a
   * real failure, not a download.
   */
  private static isDownloadResponse(resp: Response): boolean {
    if (!resp.ok || resp.status === 204 || resp.status === 205) return false;
    if (/^\s*attachment/i.test(resp.headers.get('content-disposition') ?? '')) return true;
    const type = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    return !/^(text|image|video|audio)\/|^application\/(json|xml|xhtml\+xml|javascript)$|\+(xml|json)$/.test(type);
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
  private async writeProfileIndex(
    key: string,
    entry: Pick<ProfileContext, 'workspaceId' | 'name' | 'dir' | 'createdAt' | 'lastUsed'>,
  ): Promise<void> {
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
        openPages: this.liveProfilePages(key),
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

    // In the desktop app the profile is also an Electron session. Wipe it
    // through the host; if Electron has it open, its directory must survive
    // (see BrowserWindowHost.clearSession), so the rest is removed around it.
    const dir = path.join(this.profilesRoot, wsId, safeName);
    let keep: string | undefined;
    const hostId = await this.windowHost();
    if (hostId) {
      try {
        const { live } = await this.request<{ live: boolean }>(request(this.id, hostId, 'clearSession',
          { sessionPath: path.join(dir, ELECTRON_SESSION_DIR) }));
        if (live) keep = ELECTRON_SESSION_DIR;
      } catch (err) {
        log.info(`profile session clear failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.openedElectronProfiles.delete(key);

    // Remove the on-disk profile directory.
    await this.removeProfileDir(dir, keep);

    await this.deleteProfileIndex(key);
    this.changed('profileDeleted', { profile: safeName, workspaceId: wsId });
    log.info(`profile deleted: ${key}`);
    return { deleted: true };
  }

  /** Delete a profile directory, or everything in it but `keep`. Best effort. */
  private async removeProfileDir(dir: string, keep?: string): Promise<void> {
    try {
      if (!keep) {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      }
      for (const entry of await fs.readdir(dir)) {
        if (entry !== keep) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
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
    // Over CDP, close() only disconnects; the app's Chromium is not ours to quit.
    const electronBrowser = this.electronBrowser;
    this.electronBrowser = null;
    if (electronBrowser) {
      try { await (await electronBrowser).close(); } catch { /* never connected */ }
    }
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
Pointer/keys:  clickAt(pageId, x, y, button?, clickCount?), hoverAt(pageId, x, y), drag(pageId, fromX, fromY, toX, toY), scroll(pageId, deltaY, deltaX?, x?, y?), typeText(pageId, text) — real mouse and keyboard input at viewport CSS-pixel coordinates (screenshotPage with options.scale "css" gives an image in the same pixels); each reports the element it landed on
Escape hatch:  evaluate(pageId, script) — run arbitrary JS in page context
Viewer:        viewerScreenshot(pageId), viewerInput(pageId, events), viewerNavigate(pageId, nav): no ownership check; used by the visual browser monitor for live view, human takeover (raw mouse/keyboard replay, taken only from WebBrowserViewer), and back/forward/reload

### IMPORTANT
- A click, key or script action that submits a form or activates a button may wait for the person's approval and can come back declined with PERMISSION_DENIED and a sentence saying who declined; report that and choose another way forward. Reading, scrolling, hovering, following links and typing into fields go straight through.
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
page with \`options.headful: true\`. In the desktop app that opens a real window
of the app's own browser, sharing the profile's cookies with its headless
pages; elsewhere it defaults to the installed Chrome for a real branded
fingerprint. Override with \`options.channel\`. Headful needs a display
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
