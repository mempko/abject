/**
 * WorkspaceRegistry — a Registry that chains to a fallback (global) registry
 * on discovery miss. Each workspace gets its own WorkspaceRegistry holding
 * workspace-scoped objects, while shared system objects are found via the
 * fallback chain.
 */

import { AbjectId, AbjectMessage, DiscoveryQuery, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Registry } from './registry.js';
import { request } from '../core/message.js';

const WORKSPACE_REGISTRY_INTERFACE = 'abjects:workspace-registry' as InterfaceId;

export class WorkspaceRegistry extends Registry {
  private fallbackRegistryId?: AbjectId;

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
  }

  /**
   * Set the fallback registry (typically the global Registry).
   */
  setFallback(globalRegistryId: AbjectId): void {
    this.fallbackRegistryId = globalRegistryId;
  }

  /**
   * Override ask catalog: include both workspace and global registry objects
   * so the LLM-based ask handler can see system capabilities like ShellExecutor.
   */
  protected override getSourceForAsk(): string | undefined {
    const local = super.getSourceForAsk() ?? '';
    if (!this.fallbackRegistryId) return local;

    // Append a note that global objects are discoverable via the fallback.
    // The actual catalog is fetched asynchronously in getSourceForAskAsync().
    return local + (this._globalCatalogCache
      ? `\n## System Capabilities (global registry)\n\n${this._globalCatalogCache}`
      : '');
  }

  /** Cached catalog from the global registry, refreshed on each ask. */
  private _globalCatalogCache = '';

  protected override async onInit(): Promise<void> {
    await super.onInit();
    await this.refreshGlobalCatalog();
  }

  private async refreshGlobalCatalog(): Promise<void> {
    if (!this.fallbackRegistryId) return;
    try {
      const objects = await this.request<ObjectRegistration[]>(
        request(this.id, this.fallbackRegistryId, 'list', {})
      );
      this._globalCatalogCache = objects
        .map(reg => {
          const m = reg.manifest;
          const methods = m.interface.methods
            .filter(method => !['describe', 'ask', 'ping', 'addDependent', 'removeDependent', 'checkHealth'].includes(method.name))
            .map(method => method.name)
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
   * Override discover: query locally first, chain to fallback on miss.
   */
  protected override async handleDiscover(query: DiscoveryQuery): Promise<ObjectRegistration[]> {
    const local = this.discoverObjects(query);
    if (local.length > 0) return local;

    // Chain to fallback registry
    if (this.fallbackRegistryId) {
      try {
        const remote = await this.request<ObjectRegistration[]>(
          request(this.id, this.fallbackRegistryId, 'discover', query)
        );
        return remote;
      } catch {
        return [];
      }
    }

    return [];
  }
}

export const WORKSPACE_REGISTRY_ID = 'abjects:workspace-registry' as AbjectId;
