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
  private _depCache: Record<string, AbjectId> = {};

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

  protected override getSourceForAsk(): string | undefined {
    return this._source;
  }

  /**
   * Get a dependency ID by name via Registry discovery.
   * Results are cached so subsequent calls for the same name are instant.
   */
  async dep(name: string): Promise<AbjectId> {
    if (name in this._depCache) return this._depCache[name];
    const id = await this.requireDep(name);
    this._depCache[name] = id;
    return id;
  }

  /**
   * Find an object by name via Registry discovery. Returns null if not found.
   */
  async find(name: string): Promise<AbjectId | null> {
    return this.discoverDep(name);
  }

  private setupEditableHandlers(): void {
    this.on('getSource', () => {
      return this._source;
    });

    this.on('updateSource', async (msg: AbjectMessage) => {
      const { source } = msg.payload as { source: string };
      if (msg.routing.from !== this._owner) {
        console.warn(
          `[ScriptableAbject] updateSource called by ${msg.routing.from}, owner is ${this._owner}`
        );
      }

      // Hot-reload: tear down current UI via old hide() handler
      const currentHide = this.handlers.get('hide');
      if (currentHide) {
        try {
          await currentHide(msg);
        } catch (err) {
          console.warn(`[ScriptableAbject:${this.manifest.name}] hide() during reload failed:`, err);
        }
      }

      // Swap source (removes old handlers, installs new ones)
      const result = this.applySource(source);
      if (!result.success) return result;

      // Hot-reload: re-show via new show() handler
      const newShow = this.handlers.get('show');
      if (newShow) {
        try {
          await newShow(msg);
        } catch (err) {
          console.warn(`[ScriptableAbject:${this.manifest.name}] show() during reload failed:`, err);
        }
      }

      return result;
    });

    this.installDefaultCloseHandler();
  }

  private installDefaultCloseHandler(): void {
    if (this._userMethods.has('windowCloseRequested')) return;
    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      const hideFn = (this as Record<string, unknown>)['hide'];
      if (typeof hideFn === 'function') {
        await (hideFn as MessageHandlerFn)(msg);
      }
    });
  }

  // ── Convenience methods for handler code ──────────────────────────

  /**
   * Call a method on another object via message passing.
   * The `to` parameter accepts a Promise (from this.dep()) or a plain ID.
   */
  async call<T>(to: AbjectId | string | Promise<AbjectId>, interfaceId: InterfaceId | string, method: string, payload: unknown = {}): Promise<T> {
    const resolvedTo = await to;
    return this.request<T>(
      request(this.id, resolvedTo as AbjectId, interfaceId as InterfaceId, method, payload)
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

    const baseProps = new Set(Object.keys(this));
    const proto = Object.getPrototypeOf(this);
    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        const bound = value.bind(this);
        // Don't overwrite base class methods or properties
        if (!(key in proto) && !baseProps.has(key)) {
          (this as Record<string, unknown>)[key] = bound;
        }
        if (!key.startsWith('_')) {
          // Message handler — also registered on bus
          this.on(key, bound);
          this._userMethods.add(key);
        }
      } else {
        // State property — skip if it collides with a base class field
        if (baseProps.has(key)) {
          console.warn(`[ScriptableAbject] Skipping user property '${key}' — collides with base class`);
          continue;
        }
        (this as Record<string, unknown>)[key] = value;
      }
      if (!baseProps.has(key) && !(key in proto)) {
        this._userProps.add(key);
      }
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
    const baseProps = new Set(Object.keys(this));
    const proto = Object.getPrototypeOf(this);
    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        const bound = value.bind(this);
        // Don't overwrite base class methods or properties
        if (!(key in proto) && !baseProps.has(key)) {
          (this as Record<string, unknown>)[key] = bound;
        }
        if (!key.startsWith('_')) {
          // Message handler — also registered on bus
          this.on(key, bound);
          this._userMethods.add(key);
        }
      } else {
        // State property — skip if it collides with a base class field
        if (baseProps.has(key)) {
          console.warn(`[ScriptableAbject] Skipping user property '${key}' — collides with base class`);
          continue;
        }
        (this as Record<string, unknown>)[key] = value;
      }
      if (!baseProps.has(key) && !(key in proto)) {
        this._userProps.add(key);
      }
    }

    this._source = source;
    this.installDefaultCloseHandler();

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
