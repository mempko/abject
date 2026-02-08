/**
 * ScriptableAbject — an Abject whose behavior is defined by an editable JavaScript handler map.
 *
 * Source format is a parenthesized object expression:
 *   ({
 *     greet(msg) {
 *       const { name } = msg.payload;
 *       return { greeting: 'Hello, ' + name + '!' };
 *     }
 *   })
 *
 * Handler functions are bound to the ScriptableAbject instance, giving them
 * access to this.call() for inter-object communication and this.dep() for
 * dependency lookup.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
} from '../core/types.js';
import { Abject, MessageHandlerFn } from '../core/abject.js';
import { require as contractRequire } from '../core/contracts.js';
import { request, event } from '../core/message.js';

export const EDITABLE_INTERFACE_ID = 'abjects:editable' as InterfaceId;

/**
 * An Abject whose handlers are compiled from a JavaScript source string.
 * Supports live editing: new source can be applied at runtime without restarting.
 */
export class ScriptableAbject extends Abject {
  private _source: string;
  private _owner: AbjectId;
  private _userMethods: Set<string> = new Set();
  private _userProps: Set<string> = new Set();
  private _deps: Record<string, AbjectId> = {};

  constructor(manifest: AbjectManifest, source: string, owner: AbjectId) {
    // Append the editable interface and 'scriptable' tag
    const editableInterface = {
      id: EDITABLE_INTERFACE_ID,
      name: 'Editable',
      description: 'Live-editable handler source',
      methods: [
        {
          name: 'getSource',
          description: 'Get the current handler source code',
          parameters: [],
          returns: { kind: 'primitive' as const, primitive: 'string' as const },
        },
        {
          name: 'updateSource',
          description: 'Replace handler source code at runtime',
          parameters: [
            {
              name: 'source',
              type: { kind: 'primitive' as const, primitive: 'string' as const },
              description: 'New handler map source',
            },
          ],
          returns: {
            kind: 'object' as const,
            properties: {
              success: { kind: 'primitive' as const, primitive: 'boolean' as const },
              error: { kind: 'primitive' as const, primitive: 'string' as const },
            },
          },
        },
      ],
    };

    const tags = [...(manifest.tags ?? [])];
    if (!tags.includes('scriptable')) {
      tags.push('scriptable');
    }

    super({
      manifest: {
        ...manifest,
        interfaces: [...(manifest.interfaces ?? []), editableInterface],
        tags,
      },
    });

    this._source = source;
    this._owner = owner;

    this.compileAndInstall(source);
    this.setupEditableHandlers();
  }

  get source(): string {
    return this._source;
  }

  get owner(): AbjectId {
    return this._owner;
  }

  /**
   * Set dependency IDs for inter-object communication.
   */
  setDeps(deps: Record<string, AbjectId>): void {
    this._deps = { ...deps };
  }

  protected override getSourceForAsk(): string | undefined {
    return this._source;
  }

  protected override getRegistryId(): AbjectId | undefined {
    return this._deps['Registry'] ?? super.getRegistryId();
  }

  /**
   * Get a dependency ID by name. Throws if not found.
   */
  dep(name: string): AbjectId {
    contractRequire(
      name in this._deps,
      `Dependency '${name}' not found. Available: ${Object.keys(this._deps).join(', ')}`
    );
    return this._deps[name];
  }

  /**
   * Find an object by name via Registry discovery.
   */
  async find(name: string): Promise<AbjectId | null> {
    contractRequire('Registry' in this._deps, 'Registry dependency not set');
    const results = await this.call<ObjectRegistration[]>(
      this._deps['Registry'], 'abjects:registry' as InterfaceId, 'discover', { name }
    );
    return results.length > 0 ? results[0].id as AbjectId : null;
  }

  private setupEditableHandlers(): void {
    this.on('getSource', () => {
      return this._source;
    });

    this.on('updateSource', (msg: AbjectMessage) => {
      const { source } = msg.payload as { source: string };
      if (msg.routing.from !== this._owner) {
        console.warn(
          `[ScriptableAbject] updateSource called by ${msg.routing.from}, owner is ${this._owner}`
        );
      }
      return this.applySource(source);
    });
  }

  // ── Convenience methods for handler code ──────────────────────────

  /**
   * Call a method on another object via message passing.
   */
  async call<T>(to: AbjectId | string, interfaceId: InterfaceId | string, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(
      request(this.id, to as AbjectId, interfaceId as InterfaceId, method, payload)
    );
  }

  // ── Compilation ───────────────────────────────────────────────────

  /**
   * Try to compile source without installing. Returns error message on failure, undefined on success.
   */
  static tryCompile(source: string): string | undefined {
    try {
      const handlerMap = new Function('return ' + source)();
      if (typeof handlerMap !== 'object' || handlerMap === null) {
        return 'Source must evaluate to a non-null object';
      }
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Compile source and install handlers. Throws on failure (used during construction).
   * Handler functions are bound to this instance so they can call convenience methods.
   * Non-function properties (e.g. _windowId: null) are set on the instance so handlers
   * can share state via `this`.
   */
  private compileAndInstall(source: string): void {
    const handlerMap = new Function('return ' + source)() as Record<string, MessageHandlerFn>;
    contractRequire(
      typeof handlerMap === 'object' && handlerMap !== null,
      'Handler source must evaluate to a non-null object'
    );

    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        const bound = value.bind(this);
        this.on(key, bound);
        (this as Record<string, unknown>)[key] = bound;
        this._userMethods.add(key);
      } else {
        (this as Record<string, unknown>)[key] = value;
      }
      this._userProps.add(key);
    }
  }

  /**
   * Apply new source at runtime. Returns success/error.
   * On failure, old handlers remain — the object never enters a broken state.
   */
  applySource(source: string): { success: boolean; error?: string } {
    // Compile first — if this fails, nothing changes
    let handlerMap: Record<string, MessageHandlerFn>;
    try {
      handlerMap = new Function('return ' + source)() as Record<string, MessageHandlerFn>;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (typeof handlerMap !== 'object' || handlerMap === null) {
      return { success: false, error: 'Source must evaluate to a non-null object' };
    }

    // Remove old user handlers and properties
    for (const method of this._userMethods) {
      this.off(method);
    }
    for (const prop of this._userProps) {
      delete (this as Record<string, unknown>)[prop];
    }
    this._userMethods.clear();
    this._userProps.clear();

    // Install new handlers and properties bound to this instance
    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        const bound = value.bind(this);
        this.on(key, bound);
        (this as Record<string, unknown>)[key] = bound;
        this._userMethods.add(key);
      } else {
        (this as Record<string, unknown>)[key] = value;
      }
      this._userProps.add(key);
    }

    this._source = source;

    // Emit sourceUpdated event so Negotiator can regenerate affected proxies
    const newMethods = Array.from(this._userMethods);
    this.send(
      event(
        this.id,
        this.id, // sent to self; Negotiator listens via bus subscription or handler
        EDITABLE_INTERFACE_ID,
        'sourceUpdated',
        { objectId: this.id, methods: newMethods }
      )
    ).catch(() => { /* best-effort notification */ });

    return { success: true };
  }
}
