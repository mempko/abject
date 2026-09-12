/**
 * WebExposure — per-workspace configuration for the HTTP gateway.
 *
 * A workspace decides which of its abjects the outside world may reach over
 * HTTP, and on what terms. This object holds that decision: an on/off switch
 * for the workspace, and per abject an access level (public or authenticated)
 * and an optional method allowlist. It keys entries by the abject's registered
 * name, which is durable across restarts (AbjectIds are not), the same durable
 * selector the peer-exposure list uses.
 *
 * It stores the config in its workspace's Storage and pushes the resolved
 * picture to the global WebGateway whenever it changes, so a background
 * workspace stays served without anyone opening its UI. The gateway resolves
 * names to live objects at request time; this object never hands it an id.
 *
 * The web whitelist is deliberately separate from the peer-exposure whitelist
 * (WorkspaceManager.setExposedObjects): reaching an abject from a browser and
 * reaching it from another Abject peer are different trust decisions, and
 * folding them into one list would make turning on one turn on the other.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WebExposure');

const STORAGE_KEY = 'web-exposure:config';

export type WebAccessLevel = 'public' | 'authenticated';

export interface WebExposureEntry {
  /** Access level for this abject's routes. */
  access: WebAccessLevel;
  /**
   * Methods a caller may invoke. `null` means every non-meta method the
   * manifest declares. Meta and editing methods are never invokable whatever
   * this says; the gateway enforces that.
   */
  methods: string[] | null;
}

export interface WebExposureConfig {
  enabled: boolean;
  /** Keyed by the abject's registered name. */
  entries: Record<string, WebExposureEntry>;
}

/** The shape pushed to the gateway: everything it needs to serve this workspace. */
export interface WorkspaceExposure {
  workspaceId: string;
  name: string;
  slug: string;
  registryId: AbjectId;
  enabled: boolean;
  entries: Record<string, WebExposureEntry>;
}

/** Lowercase, dash-separated, url-safe; empty falls back to a short id. */
export function slugify(name: string, fallback: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : `ws-${fallback.slice(0, 8)}`;
}

export class WebExposure extends Abject {
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private registryId?: AbjectId;
  private gatewayId?: AbjectId;
  private workspaceId?: string;
  private workspaceName = '';
  private config: WebExposureConfig = { enabled: false, entries: {} };

  constructor() {
    super({
      manifest: {
        name: 'WebExposure',
        description:
          'Per-workspace configuration for the HTTP gateway: whether this workspace is served over the web, and which abjects are reachable, at what access level (public or authenticated), and which of their methods. Keyed by abject name. Ask how to expose an abject over HTTP.',
        version: '1.0.0',
        interface: {
          id: 'abjects:web-exposure' as InterfaceId,
          name: 'WebExposure',
          description: 'HTTP exposure config for one workspace',
          methods: [
            { name: 'getConfig', description: 'The current exposure config: { enabled, entries }.', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'setEnabled', description: 'Turn web serving on or off for this workspace.', parameters: [{ name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'On or off' }], returns: { kind: 'object', properties: {} } },
            { name: 'setEntry', description: 'Expose one abject by name, or update how it is exposed.', parameters: [
              { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Registered abject name' },
              { name: 'access', type: { kind: 'primitive', primitive: 'string' }, description: '"public" or "authenticated"' },
              { name: 'methods', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Method allowlist; omit for all non-meta methods', optional: true },
            ], returns: { kind: 'object', properties: {} } },
            { name: 'removeEntry', description: 'Stop exposing one abject.', parameters: [{ name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Registered abject name' }], returns: { kind: 'object', properties: {} } },
            { name: 'setConfig', description: 'Replace the whole config in one call (used by the settings UI).', parameters: [{ name: 'config', type: { kind: 'object', properties: {} }, description: '{ enabled, entries }' }], returns: { kind: 'object', properties: {} } },
          ],
          events: [
            { name: 'exposureChanged', description: 'The exposure config changed', payload: { kind: 'object', properties: {} } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'web'],
      },
    });
    this.on('getConfig', () => structuredClone(this.config));
    this.on('setEnabled', async (msg: AbjectMessage) => {
      const { enabled } = msg.payload as { enabled: boolean };
      this.config.enabled = !!enabled;
      await this.persistAndPush();
      return { success: true, config: structuredClone(this.config) };
    });
    this.on('setEntry', async (msg: AbjectMessage) => {
      const { name, access, methods } = msg.payload as { name: string; access?: string; methods?: string[] };
      if (!name || typeof name !== 'string') return { success: false, error: 'name is required' };
      this.config.entries[name] = {
        access: access === 'public' ? 'public' : 'authenticated',
        methods: Array.isArray(methods) ? methods.filter(m => typeof m === 'string') : null,
      };
      await this.persistAndPush();
      return { success: true, config: structuredClone(this.config) };
    });
    this.on('removeEntry', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      delete this.config.entries[name];
      await this.persistAndPush();
      return { success: true, config: structuredClone(this.config) };
    });
    this.on('setConfig', async (msg: AbjectMessage) => {
      const { config } = msg.payload as { config: Partial<WebExposureConfig> };
      this.config = this.sanitize(config);
      await this.persistAndPush();
      return { success: true, config: structuredClone(this.config) };
    });
  }

  private sanitize(input: Partial<WebExposureConfig> | undefined): WebExposureConfig {
    const entries: Record<string, WebExposureEntry> = {};
    const raw = input?.entries ?? {};
    for (const [name, e] of Object.entries(raw)) {
      if (!e || typeof e !== 'object') continue;
      const access = (e as WebExposureEntry).access === 'public' ? 'public' : 'authenticated';
      const methods = Array.isArray((e as WebExposureEntry).methods)
        ? (e as WebExposureEntry).methods!.filter(m => typeof m === 'string')
        : null;
      entries[name] = { access, methods };
    }
    return { enabled: !!input?.enabled, entries };
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.registryId = await this.discoverDep('Registry') ?? undefined;
    if (this.storageId) {
      try {
        const stored = await this.request<WebExposureConfig | null>(request(this.id, this.storageId, 'get', { key: STORAGE_KEY }));
        if (stored) this.config = this.sanitize(stored);
      } catch { /* first run */ }
    }
    // Push at boot so a workspace enabled in a previous session is served
    // again. Our workspace id is assigned after spawn (WidgetManager tags us),
    // so retry until it lands, in the background — onInit must not stall.
    void this.pushWhenReady();
  }

  protected override async onStop(): Promise<void> {
    const gateway = await this.gateway();
    if (gateway) {
      try { this.send(request(this.id, gateway, 'dropWorkspace', { workspaceId: await this.ensureWorkspaceId() })); } catch { /* gateway gone */ }
    }
  }

  private async ensureWorkspaceId(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    if (this.widgetManagerId) {
      try {
        const wsId = await this.request<string | null>(request(this.id, this.widgetManagerId, 'getObjectWorkspace', { objectId: this.id }));
        if (wsId) this.workspaceId = wsId;
      } catch { /* not tagged yet */ }
    }
    if (this.workspaceId && !this.workspaceName && this.workspaceManagerId) {
      try {
        const list = await this.request<Array<{ id: string; name: string }>>(request(this.id, this.workspaceManagerId, 'listWorkspaces', {}));
        this.workspaceName = list.find(w => w.id === this.workspaceId)?.name ?? '';
      } catch { /* name stays empty; slug falls back to id */ }
    }
    return this.workspaceId;
  }

  private async pushWhenReady(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      if (await this.ensureWorkspaceId()) { await this.push(); return; }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private async gateway(): Promise<AbjectId | undefined> {
    this.gatewayId = await this.resolveDep('WebGateway', this.gatewayId);
    return this.gatewayId;
  }

  private async persistAndPush(): Promise<void> {
    if (this.storageId) {
      try { await this.request(request(this.id, this.storageId, 'set', { key: STORAGE_KEY, value: this.config })); }
      catch (err) { log.warn(`could not persist: ${err instanceof Error ? err.message : String(err)}`); }
    }
    this.changed('exposureChanged', structuredClone(this.config));
    await this.push();
  }

  private async push(): Promise<void> {
    const gateway = await this.gateway();
    const workspaceId = await this.ensureWorkspaceId();
    if (!gateway || !workspaceId || !this.registryId) return;
    const payload: WorkspaceExposure = {
      workspaceId,
      name: this.workspaceName || workspaceId.slice(0, 8),
      slug: slugify(this.workspaceName, workspaceId),
      registryId: this.registryId,
      enabled: this.config.enabled,
      entries: structuredClone(this.config.entries),
    };
    try { this.send(request(this.id, gateway, 'syncWorkspace', payload)); }
    catch (err) { log.warn(`could not push to gateway: ${err instanceof Error ? err.message : String(err)}`); }
  }
}

export const WEB_EXPOSURE_ID = 'abjects:web-exposure' as AbjectId;
