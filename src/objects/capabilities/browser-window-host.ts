/**
 * BrowserWindowHost: Electron windows for WebBrowser pages.
 *
 * Inside the desktop app, WebBrowser drives the Chromium that Electron already
 * ships rather than a separately bundled headless shell. Playwright attaches
 * to that Chromium over CDP, but it cannot open pages there: Electron answers
 * Target.createTarget with "Not supported". So the windows come from here.
 * Electron's window APIs exist only on the main process's main thread, which
 * is why this object never moves to a worker, and why WebBrowser, which does,
 * asks for its windows by message.
 *
 * A headless page is an offscreen-rendered window. A hidden ordinary window is
 * not a substitute: it stops producing frames, and a screenshot of it waits
 * forever. A headful page is a visible window the user can see and click.
 *
 * Spawned only when the backend runs inside Electron. Anywhere else WebBrowser
 * launches Chromium through Playwright, as it always has.
 */

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require as requireContract, invariant } from '../../core/contracts.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('BrowserWindowHost');

const BROWSER_WINDOW_HOST_INTERFACE = 'abjects:browser-window-host';

/**
 * The in-memory session shared by every page that has no profile. Electron
 * offers no way to destroy a session, so a fresh one per page would pile up
 * for the life of the process; instead this one is cleared whenever its last
 * window closes.
 */
const EPHEMERAL_PARTITION = 'abjects-browser-ephemeral';

/** The only caller allowed to open and close windows. */
const ADMITTED_CALLER = 'WebBrowser';

type ElectronModule = typeof import('electron');

interface Viewport { width: number; height: number }

interface HostedWindow {
  window: BrowserWindow;
  /** Profile session path, or undefined for the shared ephemeral session. */
  sessionPath?: string;
}

/**
 * BrowserWindowHost: creates and retires the Electron windows WebBrowser
 * drives.
 */
export class BrowserWindowHost extends Abject {
  private electron?: ElectronModule;
  /** Windows by the token WebBrowser finds them with. */
  private windows: Map<string, HostedWindow> = new Map();
  /** Sessions already given automation defaults (user agent, permissions, downloads). */
  private configuredSessions: WeakSet<Session> = new WeakSet();
  /** Profile sessions opened during this run, by on-disk path. */
  private profileSessions: Map<string, Session> = new Map();
  /** In-flight clear of the ephemeral session; new ephemeral pages wait for it. */
  private ephemeralClearing: Promise<void> = Promise.resolve();
  private cdpEndpoint?: string;

  constructor() {
    super({
      manifest: {
        name: 'BrowserWindowHost',
        description:
          'Desktop-app plumbing for WebBrowser: opens and closes the Electron windows its pages run in. Internal; use WebBrowser for browsing.',
        version: '1.0.0',
        interface: {
          id: BROWSER_WINDOW_HOST_INTERFACE,
          name: 'BrowserWindowHost',
          description: 'Electron window lifecycle for WebBrowser pages',
          methods: [
            {
              name: 'getCdpEndpoint',
              description: 'The DevTools endpoint of the app\'s own Chromium, for Playwright to connect to.',
              parameters: [],
              returns: {
                kind: 'object',
                properties: { endpoint: { kind: 'primitive', primitive: 'string' } },
              },
            },
            {
              name: 'createWindow',
              description: 'Open a window at about:blank#<token> so the caller can find it over CDP. Offscreen-rendered when headless, visible when headful.',
              parameters: [
                { name: 'token', type: { kind: 'primitive', primitive: 'string' }, description: 'Unique marker placed in the initial URL' },
                { name: 'sessionPath', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory of a persistent profile session; omit for the shared ephemeral session', optional: true },
                { name: 'headful', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Show a real window instead of rendering offscreen', optional: true },
                {
                  name: 'viewport',
                  type: {
                    kind: 'object',
                    properties: {
                      width: { kind: 'primitive', primitive: 'number' },
                      height: { kind: 'primitive', primitive: 'number' },
                    },
                  },
                  description: 'Content size of the window',
                },
                { name: 'userAgent', type: { kind: 'primitive', primitive: 'string' }, description: 'Per-page user agent override', optional: true },
              ],
              returns: {
                kind: 'object',
                properties: { token: { kind: 'primitive', primitive: 'string' } },
              },
            },
            {
              name: 'closeWindow',
              description: 'Close the window opened with this token, and any popups it opened. Idempotent.',
              parameters: [
                { name: 'token', type: { kind: 'primitive', primitive: 'string' }, description: 'Token the window was created with' },
              ],
              returns: {
                kind: 'object',
                properties: { closed: { kind: 'primitive', primitive: 'boolean' } },
              },
            },
            {
              name: 'clearSession',
              description: 'Close every window on a profile session and wipe its cookies, storage and cache. live is true when the session was open during this run, in which case its directory must stay on disk.',
              parameters: [
                { name: 'sessionPath', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory of the profile session' },
              ],
              returns: {
                kind: 'object',
                properties: { live: { kind: 'primitive', primitive: 'boolean' } },
              },
            },
          ],
        },
        tags: ['system', 'browser'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.electron = await import('electron');
  }

  protected override async onStop(): Promise<void> {
    for (const { window } of [...this.windows.values()]) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
    await Promise.all([...this.profileSessions.values()].map((ses) => this.flush(ses)));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.electron !== undefined || this.windows.size === 0,
      'BrowserWindowHost holds windows before Electron is loaded');
  }

  private setupHandlers(): void {
    this.on('getCdpEndpoint', async (msg: AbjectMessage) => {
      await this.admit(msg);
      return { endpoint: await this.readCdpEndpoint() };
    });

    this.on('createWindow', async (msg: AbjectMessage) => {
      await this.admit(msg);
      const p = msg.payload as {
        token: string; sessionPath?: string; headful?: boolean;
        viewport: Viewport; userAgent?: string;
      };
      return this.createWindow(p);
    });

    this.on('closeWindow', async (msg: AbjectMessage) => {
      await this.admit(msg);
      const { token } = msg.payload as { token: string };
      return { closed: this.closeWindow(token) };
    });

    this.on('clearSession', async (msg: AbjectMessage) => {
      await this.admit(msg);
      const { sessionPath } = msg.payload as { sessionPath: string };
      return this.clearSession(sessionPath);
    });
  }

  /**
   * Only WebBrowser may open windows. Anything else could put arbitrary
   * windows on the user's screen, or wipe a profile it does not own. A user
   * object calling itself WebBrowser carries a namespaced typeId
   * (`{peer}/{workspace}/user/WebBrowser`) and is turned away.
   */
  private async admit(msg: AbjectMessage): Promise<void> {
    const identity = await this.resolveCallerIdentity(msg.routing.from);
    const typeSegments = identity?.typeId ? String(identity.typeId).split('/').length : 0;
    requireContract(identity?.name === ADMITTED_CALLER && typeSegments <= 3,
      `BrowserWindowHost serves ${ADMITTED_CALLER} only`);
  }

  private requireElectron(): ElectronModule {
    requireContract(this.electron !== undefined, 'BrowserWindowHost is not initialized');
    return this.electron!;
  }

  // ===========================================================================
  // CDP endpoint
  // ===========================================================================

  /**
   * Chromium writes the port it chose for `--remote-debugging-port=0` to
   * DevToolsActivePort in the user data directory. A file left by an earlier
   * run names a port nobody is listening on, so one older than this process is
   * refused rather than trusted.
   */
  private async readCdpEndpoint(): Promise<string> {
    if (this.cdpEndpoint) return this.cdpEndpoint;
    const { app } = this.requireElectron();
    const portFile = path.join(app.getPath('userData'), 'DevToolsActivePort');
    let text: string;
    let mtimeMs: number;
    try {
      [text, { mtimeMs }] = await Promise.all([fs.readFile(portFile, 'utf8'), fs.stat(portFile)]);
    } catch {
      throw new Error(`No DevToolsActivePort at ${portFile}; the app was started without --remote-debugging-port`);
    }
    const startedAt = Date.now() - process.uptime() * 1000;
    requireContract(mtimeMs >= startedAt - 5000,
      `DevToolsActivePort at ${portFile} predates this process`);
    const port = Number(text.split('\n')[0]);
    requireContract(Number.isInteger(port) && port > 0, `Unreadable DevToolsActivePort: ${text}`);
    this.cdpEndpoint = `http://127.0.0.1:${port}`;
    log.info(`CDP endpoint ${this.cdpEndpoint}`);
    return this.cdpEndpoint;
  }

  // ===========================================================================
  // Windows
  // ===========================================================================

  private async createWindow(p: {
    token: string; sessionPath?: string; headful?: boolean;
    viewport: Viewport; userAgent?: string;
  }): Promise<{ token: string }> {
    requireContract(typeof p.token === 'string' && p.token.length > 0, 'createWindow needs a token');
    requireContract(!this.windows.has(p.token), `Window token already in use: ${p.token}`);
    requireContract(p.viewport?.width > 0 && p.viewport?.height > 0, 'createWindow needs a positive viewport');
    if (p.sessionPath !== undefined) {
      requireContract(path.isAbsolute(p.sessionPath), 'sessionPath must be absolute');
    }

    // A clear in flight must finish before a new page joins the session, or
    // it would wipe the cookies the new page is about to set.
    if (p.sessionPath === undefined) await this.ephemeralClearing;

    const { BrowserWindow } = this.requireElectron();
    const ses = this.sessionFor(p.sessionPath);
    const headful = p.headful === true;
    const window = new BrowserWindow(this.windowOptions(ses, headful, p.viewport));
    this.windows.set(p.token, { window, sessionPath: p.sessionPath });
    this.govern(window, ses, headful, p.viewport);
    window.on('closed', () => this.forget(p.token));
    if (p.sessionPath !== undefined) {
      // A login lands on disk on Chromium's schedule, not the page's. The app
      // can quit, or be killed, before that, so a profile is written through
      // whenever one of its pages finishes loading.
      window.webContents.on('did-finish-load', () => { void this.flush(ses); });
    }
    if (p.userAgent) window.webContents.setUserAgent(p.userAgent);
    if (headful) window.showInactive();

    await window.loadURL(`about:blank#${p.token}`);
    log.info(`window ${p.token} (${headful ? 'headful' : 'offscreen'}, ${p.sessionPath ? 'profile' : 'ephemeral'})`);
    this.checkInvariants();
    return { token: p.token };
  }

  private windowOptions(ses: Session, headful: boolean, viewport: Viewport): BrowserWindowConstructorOptions {
    return {
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      show: false,
      title: 'Abject Browser',
      backgroundColor: '#ffffff',
      webPreferences: {
        session: ses,
        offscreen: !headful,
        // Agents work on pages nobody is looking at; timers and animation
        // frames must keep running at full speed regardless.
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    };
  }

  /**
   * Rules every automation window lives by, popups included. A headless page
   * plays no sound through the user's speakers. Popups open in the opener's
   * session and mode (offscreen stays offscreen; an OAuth popup from a headful
   * page is a real window the user can finish), and go when their opener goes.
   */
  private govern(window: BrowserWindow, ses: Session, headful: boolean, viewport: Viewport): void {
    const contents = window.webContents;
    if (!headful) contents.setAudioMuted(true);
    // Closing a page over CDP closes its contents; take the frame with it.
    contents.once('destroyed', () => { if (!window.isDestroyed()) window.destroy(); });
    contents.setWindowOpenHandler(({ url }) => {
      if (!/^(https?:|about:blank)/i.test(url)) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: this.windowOptions(ses, headful, viewport) };
    });
    contents.on('did-create-window', (child) => {
      this.govern(child, ses, headful, viewport);
      if (headful) child.showInactive();
      window.once('closed', () => { if (!child.isDestroyed()) child.destroy(); });
    });
  }

  private closeWindow(token: string): boolean {
    const hosted = this.windows.get(token);
    if (!hosted) return false;
    if (!hosted.window.isDestroyed()) hosted.window.destroy();
    this.forget(token);
    return true;
  }

  /**
   * Drop a window from the map. A profile is written through as its page
   * goes; the ephemeral session is cleared once its last page has gone.
   */
  private forget(token: string): void {
    const hosted = this.windows.get(token);
    if (!hosted) return;
    this.windows.delete(token);
    if (hosted.sessionPath !== undefined) {
      const ses = this.profileSessions.get(hosted.sessionPath);
      if (ses) void this.flush(ses);
    } else if (!this.hasEphemeralWindows()) {
      const ses = this.requireElectron().session.fromPartition(EPHEMERAL_PARTITION);
      this.ephemeralClearing = this.wipe(ses).catch((err) => {
        log.info(`ephemeral session clear failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private hasEphemeralWindows(): boolean {
    for (const w of this.windows.values()) if (w.sessionPath === undefined) return true;
    return false;
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  private sessionFor(sessionPath: string | undefined): Session {
    const { session } = this.requireElectron();
    let ses: Session;
    if (sessionPath === undefined) {
      ses = session.fromPartition(EPHEMERAL_PARTITION);
    } else {
      ses = this.profileSessions.get(sessionPath) ?? session.fromPath(sessionPath);
      this.profileSessions.set(sessionPath, ses);
    }
    this.configure(ses);
    return ses;
  }

  /**
   * Electron's defaults suit an app, not a browser an agent drives:
   *
   * - Its user agent names Electron and the app, which sites read as
   *   automation. Pages get the tokens Chrome itself sends.
   * - It grants every permission request. Automation pages get none.
   * - It answers a download with a native save dialog. Pages never download;
   *   WebBrowser reads non-HTML responses another way.
   */
  private configure(ses: Session): void {
    if (this.configuredSessions.has(ses)) return;
    this.configuredSessions.add(ses);
    ses.setUserAgent(this.chromeUserAgent());
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
  }

  /**
   * Electron's default user agent with the app's and Electron's own tokens
   * removed and the Chrome version reduced the way Chrome reduces it:
   * `... (KHTML, like Gecko) abjects/0.13.0 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36`
   * becomes `... (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36`.
   */
  private chromeUserAgent(): string {
    return this.requireElectron().app.userAgentFallback
      .replace(/ (?!(?:Mozilla|AppleWebKit|Chrome|Safari)\/)[^\s()/]+\/\S+/g, '')
      .replace(/Chrome\/(\d+)[\d.]*/, 'Chrome/$1.0.0.0');
  }

  private async clearSession(sessionPath: string): Promise<{ live: boolean }> {
    requireContract(path.isAbsolute(sessionPath), 'sessionPath must be absolute');
    for (const [token, hosted] of [...this.windows]) {
      if (hosted.sessionPath === sessionPath) this.closeWindow(token);
    }
    // A session Electron has opened keeps its database files open, and asking
    // for the same path again returns the same session. Deleting its directory
    // would leave it writing to unlinked files, so a live one is wiped in place
    // and reported live, and its directory stays.
    const ses = this.profileSessions.get(sessionPath);
    if (!ses) return { live: false };
    await this.wipe(ses);
    log.info(`cleared profile session ${sessionPath}`);
    return { live: true };
  }

  /** Write a session's cookies and DOM storage to disk now. Best effort. */
  private async flush(ses: Session): Promise<void> {
    try {
      ses.flushStorageData();
      await ses.cookies.flushStore();
    } catch (err) {
      log.info(`session flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async wipe(ses: Session): Promise<void> {
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  }
}

// Well-known BrowserWindowHost ID
export const BROWSER_WINDOW_HOST_ID = 'abjects:browser-window-host' as AbjectId;
