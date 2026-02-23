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
   * Override discover: query locally first, chain to fallback on miss.
   */
  protected override async handleDiscover(query: DiscoveryQuery): Promise<ObjectRegistration[]> {
    const local = this.discoverObjects(query);
    if (local.length > 0) return local;

    // Chain to fallback registry
    if (this.fallbackRegistryId) {
      try {
        const remote = await this.request<ObjectRegistration[]>(
          request(this.id, this.fallbackRegistryId, 'abjects:registry' as InterfaceId, 'discover', query)
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
