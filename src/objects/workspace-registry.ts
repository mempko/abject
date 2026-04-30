/**
 * WorkspaceRegistry — a Registry that chains to a fallback (global) registry
 * on discovery miss. Each workspace gets its own WorkspaceRegistry holding
 * workspace-scoped objects, while shared system objects are found via the
 * fallback chain.
 *
 * Two chaining strategies are mixed:
 *   - `discover` chains "fallback only on miss" because lookups want one
 *     answer (a name resolves to one Abject).
 *   - `list` / `listSummaries` always merge local + fallback because callers
 *     (CommandPalette, ProcessExplorer, AppExplorer-style UIs) need the
 *     complete picture: workspace-local Abjects *and* system services.
 */

import { AbjectId, AbjectMessage, DiscoveryQuery, InterfaceId, ObjectRegistration } from '../core/types.js';
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
