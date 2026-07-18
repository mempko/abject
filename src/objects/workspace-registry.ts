/**
 * WorkspaceRegistry — a Registry that chains to a fallback (global) registry
 * on discovery miss. Each workspace gets its own WorkspaceRegistry holding
 * workspace-scoped objects, while shared system objects are found via the
 * fallback chain.
 *
 * Two chaining strategies are mixed:
 *   - `discover` / `getSource` / `updateSource` / `updateManifest` chain
 *     "fallback only on miss" because lookups want one answer (a name or id
 *     resolves to one Abject — its source is part of that identity, so an
 *     object spawned without a registryHint into the global registry must be
 *     just as readable and editable through the workspace registry).
 *   - `list` / `listSummaries` always merge local + fallback because callers
 *     (CommandPalette, ProcessExplorer, AppExplorer-style UIs) need the
 *     complete picture: workspace-local Abjects *and* system services.
 */

import { AbjectId, AbjectManifest, AbjectMessage, DiscoveryQuery, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Registry } from './registry.js';
import { request } from '../core/message.js';

const WORKSPACE_REGISTRY_INTERFACE = 'abjects:workspace-registry' as InterfaceId;
void WORKSPACE_REGISTRY_INTERFACE;

export class WorkspaceRegistry extends Registry {
  private fallbackRegistryId?: AbjectId;
  /** Cached catalog from the global registry, refreshed in onInit / setFallback. */
  private _globalCatalogCache = '';

  /** Mirror of base Registry's META_METHODS (private upstream, so we can't
   * reuse it directly); used when we recompute summaries locally because we
   * replaced the base handler. */
  private static readonly META_METHODS_LOCAL = new Set([
    'describe', 'ask', 'getRegistry', 'ping',
    'addDependent', 'removeDependent',
    'getSource', 'updateSource', 'probe',
  ]);

  constructor() {
    super();
    this.setupWorkspaceHandlers();
  }

  private setupWorkspaceHandlers(): void {
    this.on('setFallback', async (msg: AbjectMessage) => {
      const { registryId } = msg.payload as { registryId: AbjectId };
      this.fallbackRegistryId = registryId;
      await this.refreshGlobalCatalog();
      return true;
    });

    // Override getSource / updateSource / updateManifest to chain on local
    // miss. Resolution is by identity, not by which registry holds the entry:
    // an object spawned without a registryHint lands in the fallback (global)
    // registry, and its source must still be readable (load_target's fetch)
    // and its cached source/manifest writable (deploy_update's cache sync)
    // through the workspace registry. Forward the original payload verbatim —
    // getSource/updateSource accept objectId | typeId | name | ref, and the
    // fallback resolves by the same rules.
    this.on('getSource', async (msg: AbjectMessage) => {
      const { objectId, typeId, name, ref } = msg.payload as {
        objectId?: string; typeId?: string; name?: string; ref?: string;
      };
      const local = this.getObjectSource(ref ?? objectId ?? typeId ?? name ?? '');
      if (local !== null) return local;
      if (!this.fallbackRegistryId) return null;
      try {
        return await this.request<string | null>(
          request(this.id, this.fallbackRegistryId, 'getSource', msg.payload as Record<string, unknown>),
        );
      } catch {
        return null;
      }
    });

    this.on('updateSource', async (msg: AbjectMessage) => {
      const { objectId, typeId, name, ref, source } = msg.payload as {
        objectId?: string; typeId?: string; name?: string; ref?: string; source: string;
      };
      const reg = this.resolveRegistration(ref ?? objectId ?? typeId ?? name ?? '');
      if (reg) {
        reg.source = source;
        return true;
      }
      if (!this.fallbackRegistryId) return false;
      try {
        return await this.request<boolean>(
          request(this.id, this.fallbackRegistryId, 'updateSource', msg.payload as Record<string, unknown>),
        );
      } catch {
        return false;
      }
    });

    this.on('updateManifest', async (msg: AbjectMessage) => {
      const { objectId, manifest } = msg.payload as { objectId: AbjectId; manifest: AbjectManifest };
      if (this.lookupObject(objectId)) {
        return this.updateManifestRegistration(objectId, manifest);
      }
      if (!this.fallbackRegistryId) return false;
      try {
        return await this.request<boolean>(
          request(this.id, this.fallbackRegistryId, 'updateManifest', msg.payload as Record<string, unknown>),
        );
      } catch {
        return false;
      }
    });

    // Override list / listSummaries to union local + global.
    this.on('list', async () => {
      const local = this.listObjects();
      const remote = await this.fallbackList();
      return mergeById(local, remote);
    });

    this.on('listSummaries', async () => {
      const local = this.localListSummaries();
      const remote = await this.fallbackListSummaries();
      return mergeById(local as Array<{ id?: string }>, remote as Array<{ id?: string }>);
    });
  }

  /**
   * Set the fallback registry (typically the global Registry).
   */
  setFallback(globalRegistryId: AbjectId): void {
    this.fallbackRegistryId = globalRegistryId;
  }

  protected override async onInit(): Promise<void> {
    await super.onInit();
    await this.refreshGlobalCatalog();
  }

  /**
   * Override ask catalog: include both workspace and global registry objects
   * so the LLM-based ask handler can see system capabilities like ShellExecutor.
   */
  protected override askPrompt(_question: string): string {
    const local = super.askPrompt(_question);
    if (!this.fallbackRegistryId) return local;

    return local + (this._globalCatalogCache
      ? `\n## System Capabilities (global registry)\n\n${this._globalCatalogCache}`
      : '');
  }

  /**
   * Override discover: query locally first, chain to fallback on miss.
   */
  protected override async handleDiscover(query: DiscoveryQuery): Promise<ObjectRegistration[]> {
    const local = this.discoverObjects(query);
    if (local.length > 0) return local;

    if (this.fallbackRegistryId) {
      try {
        return await this.request<ObjectRegistration[]>(
          request(this.id, this.fallbackRegistryId, 'discover', query),
        );
      } catch {
        return [];
      }
    }

    return [];
  }

  private async refreshGlobalCatalog(): Promise<void> {
    if (!this.fallbackRegistryId) return;
    try {
      const objects = await this.request<ObjectRegistration[]>(
        request(this.id, this.fallbackRegistryId, 'list', {}),
      );
      this._globalCatalogCache = objects
        .map((reg) => {
          const m = reg.manifest;
          const methods = m.interface.methods
            .filter((method) => !['describe', 'ask', 'ping', 'addDependent', 'removeDependent', 'checkHealth'].includes(method.name))
            .map((method) => method.name)
            .join(', ');
          let line = `- **${reg.name ?? m.name}**: ${m.description}`;
          if (methods) line += ` Methods: ${methods}`;
          return line;
        })
        .join('\n');
    } catch {
      // Keep existing cache on failure
    }
  }

  /**
   * Re-implement summary computation here because base Registry's `toSummary`
   * is private; structurally identical so callers see one shape.
   */
  private localListSummaries(): unknown[] {
    return this.listObjects().map((reg) => {
      const m = reg.manifest;
      const methods = m.interface.methods
        .filter((method) => !WorkspaceRegistry.META_METHODS_LOCAL.has(method.name))
        .map((method) => method.name);
      return {
        id: reg.id,
        typeId: reg.typeId,
        name: reg.name ?? m.name,
        description: m.description,
        methods,
        tags: m.tags,
      };
    });
  }

  private async fallbackList(): Promise<ObjectRegistration[]> {
    if (!this.fallbackRegistryId) return [];
    try {
      return await this.request<ObjectRegistration[]>(
        request(this.id, this.fallbackRegistryId, 'list', {}),
      );
    } catch {
      return [];
    }
  }

  private async fallbackListSummaries(): Promise<unknown[]> {
    if (!this.fallbackRegistryId) return [];
    try {
      return await this.request<unknown[]>(
        request(this.id, this.fallbackRegistryId, 'listSummaries', {}),
      );
    } catch {
      return [];
    }
  }
}

/**
 * Merge two arrays by `id`, preserving local order first. Defensive against
 * malformed entries that lack an id.
 */
function mergeById<T extends { id?: string }>(local: T[], remote: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of local) {
    if (item.id) seen.add(item.id);
    out.push(item);
  }
  for (const item of remote) {
    if (item.id && seen.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

export const WORKSPACE_REGISTRY_ID = 'abjects:workspace-registry' as AbjectId;
