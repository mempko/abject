/**
 * AppUpdater: keeps the packaged desktop app up to date.
 *
 * It reads the release feed the build wrote into resources/app-update.yml
 * (GitHub releases), downloads a newer version in the background, and installs
 * it when the app quits or when the user asks to restart. It holds no UI: the
 * Updates tab of the Settings window observes its `updateStatus` aspect and
 * drives it.
 *
 * How an update is applied depends on how Abject was installed:
 * - Windows (NSIS): the downloaded installer runs silently once the app has
 *   exited, and starts it again after a restart.
 * - Linux AppImage: the new AppImage replaces the old file at the same path.
 * - Linux .deb: dpkg installs it, which asks for an administrator password, so
 *   that happens only when the user restarts to update.
 * - macOS, or a Linux install it cannot replace: the update is offered as a
 *   download. Squirrel.Mac only updates a signed app, and builds are not
 *   signed yet.
 *
 * Installing runs in Electron's `will-quit`, after the backend has shut down
 * and released its database, ports and single-instance lock. A restart then
 * starts the new version once this process is gone; started any earlier, it
 * would find the lock taken and quit.
 *
 * Spawned only in the packaged Electron app, on the main thread: it needs
 * Electron's `app`, and `electron-updater` ships only in the desktop app.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { AppUpdater as ElectronUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('AppUpdater');

type ElectronModule = typeof import('electron');

/** Where a check stands. */
export type UpdateState = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'error';

/**
 * How this copy of Abject gets a new version: replaced in place by the
 * updater (nsis, appimage, deb), or downloaded by the user (manual).
 */
export type InstallKind = 'nsis' | 'appimage' | 'deb' | 'manual';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  installKind: InstallKind;
  /** Why updates are manual on this install, when they are. */
  manualReason?: string;
  /** Installing asks for an administrator password (.deb). */
  needsPassword: boolean;
  autoDownload: boolean;
  latestVersion?: string;
  releaseDate?: string;
  /** The release's page, for its notes. */
  releaseUrl?: string;
  /** The file a manual update downloads. */
  downloadUrl?: string;
  /** Download progress, 0 to 100, while downloading. */
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
  lastCheckedAt?: number;
}

/** The only caller allowed to download, restart, open pages or change settings: the Settings window. */
const ADMITTED_CALLER = 'GlobalSettings';

/** Electron app event the native Help menu emits; see electron/main.ts. */
export const CHECK_FOR_UPDATES_EVENT = 'abjects:check-for-updates';

const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const STORAGE_KEY_AUTO_DOWNLOAD = 'appUpdater:autoDownload';

/**
 * Feed override: a generic feed URL (a directory holding latest*.yml and the
 * files they name) used instead of the GitHub releases in app-update.yml.
 * For a mirror, or for testing an update end to end without publishing.
 */
const FEED_URL_ENV = 'ABJECTS_UPDATE_FEED_URL';

/**
 * The install to run in `will-quit`. Module level, so it outlives the
 * AppUpdater instance (which is stopped with the rest of the backend before
 * `will-quit`) and so a restarted instance replaces the hook rather than
 * adding a second one.
 */
let installOnQuit: (() => void) | undefined;
let quitHookRegistered = false;

export class AppUpdater extends Abject {
  private electron?: ElectronModule;
  private updater?: ElectronUpdater;
  private storageId?: AbjectId;
  private current: UpdateStatus = {
    state: 'idle', currentVersion: '0.0.0', installKind: 'manual', needsPassword: false, autoDownload: true,
  };
  /** The verified file a finished download left in the updater's cache. */
  private downloadedFile?: string;
  /** Set by restartToUpdate: start the new version after installing. */
  private restartRequested = false;
  /** Listeners added to the shared updater, removed again in onStop. */
  private detach: Array<() => void> = [];
  private lastProgressPercent = -1;

  constructor() {
    super({
      manifest: {
        name: 'AppUpdater',
        description:
          'Keeps the Abject desktop app up to date: checks for new versions, downloads them in the background, and installs them when the app restarts or quits. ' +
          'Ask it which version is running and whether an update is available, or to check now.',
        version: '1.0.0',
        interface: {
          id: 'abjects:app-updater' as InterfaceId,
          name: 'AppUpdater',
          description: 'Software updates for the desktop app',
          methods: [
            {
              name: 'getStatus',
              description: 'The running version, the newest version found, and where an update stands (checking, available, downloading, ready to install).',
              parameters: [],
              returns: { kind: 'reference', reference: 'UpdateStatus' },
            },
            {
              name: 'checkNow',
              description: 'Check for a new version now. The result arrives as an updateStatus change; with automatic downloads on, a new version starts downloading.',
              parameters: [],
              returns: { kind: 'reference', reference: 'UpdateStatus' },
            },
            {
              name: 'download',
              description: 'Download the available update.',
              parameters: [],
              returns: { kind: 'reference', reference: 'UpdateStatus' },
            },
            {
              name: 'restartToUpdate',
              description: 'Quit, install the downloaded update, and start the new version.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'openPage',
              description: 'Open the update\'s download (a manual update) or its release notes in the browser.',
              parameters: [
                { name: 'page', type: { kind: 'primitive', primitive: 'string' }, description: "'download' or 'release'" },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'setAutoDownload',
              description: 'Turn automatic background downloads on or off.',
              parameters: [
                { name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Download new versions automatically' },
              ],
              returns: { kind: 'reference', reference: 'UpdateStatus' },
            },
          ],
          events: [
            { name: 'updateStatus', description: 'The update status changed (changed aspect, value: UpdateStatus).', payload: { kind: 'reference', reference: 'UpdateStatus' } },
            { name: 'showRequested', description: 'The app menu asked to show software updates (changed aspect).', payload: { kind: 'object', properties: {} } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'updates'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.electron = await import('electron');
    const { app } = this.electron;
    this.current.currentVersion = app.getVersion();
    const kind = detectInstallKind();
    this.current.installKind = kind.kind;
    this.current.manualReason = kind.reason;
    this.current.needsPassword = kind.kind === 'deb';

    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.current.autoDownload = await this.loadAutoDownload();

    this.updater = await createUpdater(kind.kind);
    this.configureUpdater(this.updater);

    const onMenu = (): void => {
      this.changed('showRequested', {});
      void this.check();
    };
    // A custom event on app, not one of Electron's own: see electron/main.ts.
    const emitter = app as unknown as NodeJS.EventEmitter;
    emitter.on(CHECK_FOR_UPDATES_EVENT, onMenu);
    this.detach.push(() => emitter.off(CHECK_FOR_UPDATES_EVENT, onMenu));

    this.setTimer(() => this.check(), FIRST_CHECK_DELAY_MS);
    this.setRecurringTimer(() => this.check(), CHECK_INTERVAL_MS);
    log.info(`version ${this.current.currentVersion}, updates ${kind.kind}${kind.reason ? ` (${kind.reason})` : ''}`);
  }

  protected override async onStop(): Promise<void> {
    // The install hook stays: it runs in will-quit, after this has stopped.
    for (const off of this.detach) off();
    this.detach = [];
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.current.state !== 'ready' || this.downloadedFile !== undefined,
      'AppUpdater is ready to install without a downloaded file');
    invariant(this.current.state !== 'downloading' || this.current.installKind !== 'manual',
      'AppUpdater downloads only updates it can install');
  }

  private setupHandlers(): void {
    this.on('getStatus', () => this.snapshot());

    this.on('checkNow', async () => {
      await this.check();
      return this.snapshot();
    });

    this.on('download', async (msg: AbjectMessage) => {
      await this.admit(msg);
      this.startDownload();
      return this.snapshot();
    });

    this.on('restartToUpdate', async (msg: AbjectMessage) => {
      await this.admit(msg);
      precondition(this.current.state === 'ready', 'No downloaded update to install');
      this.restartRequested = true;
      log.info(`restarting to install ${this.current.latestVersion}`);
      // Reply first; quitting tears down the bus.
      setTimeout(() => this.requireElectron().app.quit(), 200);
      return true;
    });

    this.on('openPage', async (msg: AbjectMessage) => {
      await this.admit(msg);
      const { page } = msg.payload as { page?: string };
      precondition(page === 'download' || page === 'release', "page must be 'download' or 'release'");
      const url = page === 'download' ? this.current.downloadUrl ?? this.current.releaseUrl : this.current.releaseUrl;
      if (!url) return false;
      await this.requireElectron().shell.openExternal(url);
      return true;
    });

    this.on('setAutoDownload', async (msg: AbjectMessage) => {
      await this.admit(msg);
      const { enabled } = msg.payload as { enabled?: unknown };
      precondition(typeof enabled === 'boolean', 'enabled must be a boolean');
      this.current.autoDownload = enabled as boolean;
      await this.saveAutoDownload(this.current.autoDownload);
      if (this.current.autoDownload && this.current.state === 'available') this.startDownload();
      this.publish();
      return this.snapshot();
    });
  }

  /**
   * Only the Settings window may download, restart, open pages or change the
   * setting. Restarting the app is the user's call; an agent or a user object
   * calling itself GlobalSettings carries a namespaced typeId and is turned
   * away. Reading the status and checking stay open to everyone.
   */
  private async admit(msg: AbjectMessage): Promise<void> {
    const identity = await this.resolveCallerIdentity(msg.routing.from);
    const typeSegments = identity?.typeId ? String(identity.typeId).split('/').length : 0;
    precondition(identity?.name === ADMITTED_CALLER && typeSegments <= 3,
      `AppUpdater takes this request from ${ADMITTED_CALLER} only`);
  }

  private requireElectron(): ElectronModule {
    precondition(this.electron !== undefined, 'AppUpdater is not initialized');
    return this.electron!;
  }

  private snapshot(): UpdateStatus {
    return { ...this.current };
  }

  private publish(): void {
    this.checkInvariants();
    this.changed('updateStatus', this.snapshot());
  }

  // ===========================================================================
  // Checking and downloading
  // ===========================================================================

  private configureUpdater(updater: ElectronUpdater): void {
    // Downloads start here, when the setting allows; installs run in will-quit.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = {
      info: (m?: unknown) => log.info(String(m)),
      warn: (m?: unknown) => log.warn(String(m)),
      error: (m?: unknown) => log.error(String(m)),
      debug: () => { /* quiet */ },
    };
    const feedUrl = process.env[FEED_URL_ENV];
    if (feedUrl) {
      updater.setFeedURL({ provider: 'generic', url: feedUrl });
      log.info(`feed overridden by ${FEED_URL_ENV}: ${feedUrl}`);
    }

    const listen = <A extends unknown[]>(event: string, fn: (...args: A) => void): void => {
      const handler = fn as (...args: unknown[]) => void;
      (updater as unknown as NodeJS.EventEmitter).on(event, handler);
      this.detach.push(() => (updater as unknown as NodeJS.EventEmitter).off(event, handler));
    };
    listen('update-available', (info: UpdateInfo) => this.onAvailable(info));
    listen('update-not-available', (info: UpdateInfo) => {
      this.current = { ...this.current, state: 'upToDate', latestVersion: info.version, error: undefined };
      this.publish();
    });
    listen('download-progress', (p: ProgressInfo) => this.onProgress(p));
    listen('update-downloaded', (e: UpdateDownloadedEvent) => this.onDownloaded(e));
    listen('error', (err: Error) => {
      this.current = { ...this.current, state: 'error', error: err?.message ?? String(err), percent: undefined };
      this.publish();
    });
  }

  private async check(): Promise<void> {
    const busy: UpdateState[] = ['checking', 'downloading', 'ready'];
    if (!this.updater || busy.includes(this.current.state)) return;
    this.current = { ...this.current, state: 'checking', error: undefined };
    this.publish();
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      // The error event reports it too; this covers a rejection without one.
      if (this.current.state === 'checking') {
        this.current = { ...this.current, state: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      this.current.lastCheckedAt = Date.now();
      // A check the updater never answered (no event) falls back to idle.
      if (this.current.state === 'checking') this.current.state = 'idle';
      this.publish();
    }
  }

  private onAvailable(info: UpdateInfo): void {
    const feed = readFeed();
    this.current = {
      ...this.current,
      state: 'available',
      latestVersion: info.version,
      releaseDate: info.releaseDate,
      releaseUrl: feed.releaseUrl(info.version),
      downloadUrl: this.current.installKind === 'manual' ? feed.fileUrl(info.version, pickManualFile(info)) : undefined,
      error: undefined,
    };
    this.publish();
    if (this.current.autoDownload) this.startDownload();
  }

  private startDownload(): void {
    if (!this.updater || this.current.installKind === 'manual') return;
    // Retrying after a failed download is allowed once a version is known.
    const startable = this.current.state === 'available' || (this.current.state === 'error' && !!this.current.latestVersion);
    if (!startable) return;
    this.current = { ...this.current, state: 'downloading', percent: 0, error: undefined };
    this.lastProgressPercent = -1;
    this.publish();
    this.updater.downloadUpdate().catch((err: unknown) => {
      // The error event normally reports it first.
      if (this.current.state === 'downloading') {
        this.current = { ...this.current, state: 'error', error: err instanceof Error ? err.message : String(err), percent: undefined };
        this.publish();
      }
    });
  }

  private onProgress(p: ProgressInfo): void {
    const percent = Math.floor(p.percent);
    if (percent === this.lastProgressPercent) return;
    this.lastProgressPercent = percent;
    this.current = { ...this.current, state: 'downloading', percent, transferredBytes: p.transferred, totalBytes: p.total };
    this.publish();
  }

  private onDownloaded(e: UpdateDownloadedEvent): void {
    this.downloadedFile = e.downloadedFile;
    this.current = { ...this.current, state: 'ready', latestVersion: e.version, percent: 100, error: undefined };
    this.armInstallOnQuit();
    log.info(`downloaded ${e.version} to ${e.downloadedFile}`);
    this.publish();
  }

  // ===========================================================================
  // Installing
  // ===========================================================================

  private armInstallOnQuit(): void {
    const { app } = this.requireElectron();
    installOnQuit = () => this.install();
    if (!quitHookRegistered) {
      quitHookRegistered = true;
      // Runs after main.ts's own will-quit work: the backend is down by then.
      app.on('will-quit', () => installOnQuit?.());
    }
  }

  /** Runs in will-quit. Synchronous: nothing after will-quit waits for promises. */
  private install(): void {
    const file = this.downloadedFile;
    if (!file || !this.updater) return;
    installOnQuit = undefined;
    const restart = this.restartRequested;
    try {
      switch (this.current.installKind) {
        case 'nsis':
          // The installer waits for this process to exit; --force-run starts the app after.
          asInstaller(this.updater).install(true, restart);
          break;
        case 'appimage': {
          const target = replaceAppImage(file);
          if (restart) relaunchAfterExit(target);
          break;
        }
        case 'deb':
          // dpkg asks for a password, which only makes sense when the user asked to restart.
          if (!restart) return;
          if (asInstaller(this.updater).install(true, false)) {
            relaunchAfterExit(launcherPath());
          }
          break;
        case 'manual':
          break;
      }
      log.info(`installed ${this.current.latestVersion}${restart ? ', restarting' : ''}`);
    } catch (err) {
      log.error(`install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ===========================================================================
  // Settings
  // ===========================================================================

  private async loadAutoDownload(): Promise<boolean> {
    if (!this.storageId) return true;
    try {
      const v = await this.request<unknown>(request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTO_DOWNLOAD }));
      return v === false ? false : true;
    } catch {
      return true;
    }
  }

  private async saveAutoDownload(enabled: boolean): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', { key: STORAGE_KEY_AUTO_DOWNLOAD, value: enabled }));
    } catch (err) {
      log.warn(`could not save the download setting: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// =============================================================================
// Install method
// =============================================================================

function detectInstallKind(): { kind: InstallKind; reason?: string } {
  if (process.platform === 'win32') return { kind: 'nsis' };
  if (process.platform === 'darwin') {
    return { kind: 'manual', reason: 'Mac builds are not signed yet, so they cannot replace themselves' };
  }
  const appImage = process.env.APPIMAGE;
  if (appImage) {
    try {
      fs.accessSync(path.dirname(appImage), fs.constants.W_OK);
      return { kind: 'appimage' };
    } catch {
      return { kind: 'manual', reason: `the folder holding the AppImage (${path.dirname(appImage)}) is not writable` };
    }
  }
  try {
    const type = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    if (type === 'deb') return { kind: 'deb' };
  } catch { /* not a package install */ }
  return { kind: 'manual', reason: 'this install is not one the updater can replace' };
}

/**
 * The updater for this install, chosen here rather than by electron-updater's
 * default: that one picks the .deb updater whenever resources/package-type
 * exists, which an AppImage built alongside the .deb can carry.
 */
async function createUpdater(kind: InstallKind): Promise<ElectronUpdater> {
  const mod = await import('electron-updater');
  // Imported from ESM, the CommonJS module's exports arrive as `default`.
  const lib = (mod as unknown as { default?: typeof mod }).default ?? mod;
  switch (kind) {
    case 'nsis': return new lib.NsisUpdater();
    case 'deb': return new lib.DebUpdater();
    case 'appimage': return new lib.AppImageUpdater();
    case 'manual':
      // Only checks: any updater reads the platform's latest*.yml.
      return process.platform === 'darwin' ? new lib.MacUpdater() : new lib.AppImageUpdater();
  }
}

/** NsisUpdater and DebUpdater install a downloaded update with install(silent, forceRunAfter). */
function asInstaller(updater: ElectronUpdater): { install(isSilent: boolean, isForceRunAfter: boolean): boolean } {
  return updater as unknown as { install(isSilent: boolean, isForceRunAfter: boolean): boolean };
}

// =============================================================================
// Feed URLs
// =============================================================================

interface Feed {
  releaseUrl(version: string): string | undefined;
  fileUrl(version: string, file: string | undefined): string | undefined;
}

/** Page and file URLs for the configured feed: the override, or app-update.yml's GitHub repo. */
function readFeed(): Feed {
  const override = process.env[FEED_URL_ENV];
  if (override) {
    const base = override.replace(/\/+$/, '');
    return { releaseUrl: () => base, fileUrl: (_v, file) => (file ? `${base}/${encodeURIComponent(file)}` : undefined) };
  }
  let owner: string | undefined;
  let repo: string | undefined;
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    owner = /^owner:\s*(\S+)/m.exec(yml)?.[1];
    repo = /^repo:\s*(\S+)/m.exec(yml)?.[1];
  } catch { /* no feed config */ }
  if (!owner || !repo) return { releaseUrl: () => undefined, fileUrl: () => undefined };
  const root = `https://github.com/${owner}/${repo}/releases`;
  return {
    releaseUrl: (v) => `${root}/tag/v${v}`,
    fileUrl: (v, file) => (file ? `${root}/download/v${v}/${encodeURIComponent(file)}` : `${root}/tag/v${v}`),
  };
}

/** The file a manual update downloads: the DMG for this Mac's architecture, or the AppImage. */
function pickManualFile(info: UpdateInfo): string | undefined {
  const names = (info.files ?? []).map(f => f.url);
  if (process.platform === 'darwin') {
    const dmgs = names.filter(n => n.endsWith('.dmg'));
    return process.arch === 'arm64'
      ? dmgs.find(n => n.includes('arm64'))
      : dmgs.find(n => !n.includes('arm64'));
  }
  return names.find(n => n.endsWith('.AppImage'));
}

// =============================================================================
// Replacing and relaunching
// =============================================================================

/**
 * Put the downloaded AppImage where the running one is, under the same name,
 * so launchers and shortcuts keep working. The rename is atomic, and replacing
 * a running file is safe on Linux: this process keeps the old one open.
 * (electron-updater's own AppImage install renames the file to the new version
 * and then runs it once, which would start a second copy of the app while this
 * one is still shutting down.)
 */
function replaceAppImage(downloaded: string): string {
  const target = process.env.APPIMAGE;
  precondition(!!target && path.isAbsolute(target), 'APPIMAGE is not set to an absolute path');
  const staged = path.join(path.dirname(target!), `.${path.basename(target!)}.update`);
  fs.copyFileSync(downloaded, staged);
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, target!);
  return target!;
}

/**
 * The command that starts this install: the --no-sandbox wrapper that
 * electron/afterPack.cjs puts in front of the Electron binary (`<name>.bin`)
 * on Linux, when it is there.
 */
function launcherPath(): string {
  const exe = process.execPath;
  if (exe.endsWith('.bin')) {
    const wrapper = exe.slice(0, -'.bin'.length);
    if (fs.existsSync(wrapper)) return wrapper;
  }
  return exe;
}

/**
 * Start `target` once this process has exited, from a detached shell that
 * waits for our pid to go away. Started earlier, the new copy would find the
 * single-instance lock held and quit at once.
 */
function relaunchAfterExit(target: string): void {
  const env = { ...process.env };
  // The old AppImage's mount variables would point the new one at a mount that is going away.
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[k];
  const args = process.argv.slice(1).filter(a => a !== '--no-sandbox');
  const script = 'pid="$1"; shift; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done; exec "$@"';
  const child = spawn('/bin/sh', ['-c', script, 'abject-relaunch', String(process.pid), target, ...args], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
}

export const APP_UPDATER_ID = 'abjects:app-updater' as AbjectId;
