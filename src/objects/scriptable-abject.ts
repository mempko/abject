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
 * access to convenience methods like createWindow(), addWidget(), call(), etc.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject, MessageHandlerFn } from '../core/abject.js';
import { require as contractRequire } from '../core/contracts.js';
import { request } from '../core/message.js';

export const EDITABLE_INTERFACE_ID = 'abjects:editable' as InterfaceId;

const UI_INTERFACE: InterfaceId = 'abjects:ui' as InterfaceId;

export interface SystemContext {
  registryId: AbjectId;
  uiServerId: AbjectId;
}

/**
 * An Abject whose handlers are compiled from a JavaScript source string.
 * Supports live editing: new source can be applied at runtime without restarting.
 */
export class ScriptableAbject extends Abject {
  private _source: string;
  private _owner: AbjectId;
  private _userMethods: Set<string> = new Set();
  private _systemCtx?: SystemContext;

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
   * Set the system context (registry and UI server IDs) for convenience methods.
   */
  setSystemContext(ctx: SystemContext): void {
    this._systemCtx = ctx;
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

  /**
   * Create a window via UIServer.
   */
  async createWindow(
    title: string,
    rect: { x: number; y: number; width: number; height: number },
    options?: { resizable?: boolean }
  ): Promise<string> {
    contractRequire(this._systemCtx !== undefined, 'System context not set');
    return this.request<string>(
      request(this.id, this._systemCtx!.uiServerId, UI_INTERFACE, 'createWindow', {
        title,
        rect,
        zIndex: 200,
        resizable: options?.resizable ?? false,
      })
    );
  }

  /**
   * Add a widget to a window.
   */
  async addWidget(
    windowId: string,
    id: string,
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    options?: { text?: string; placeholder?: string; monospace?: boolean; masked?: boolean }
  ): Promise<boolean> {
    contractRequire(this._systemCtx !== undefined, 'System context not set');
    return this.request<boolean>(
      request(this.id, this._systemCtx!.uiServerId, UI_INTERFACE, 'addWidget', {
        windowId,
        id,
        type,
        rect,
        ...options,
      })
    );
  }

  /**
   * Update a widget's text or other properties.
   */
  async updateWidget(widgetId: string, text: string): Promise<boolean> {
    contractRequire(this._systemCtx !== undefined, 'System context not set');
    return this.request<boolean>(
      request(this.id, this._systemCtx!.uiServerId, UI_INTERFACE, 'updateWidget', {
        widgetId,
        text,
      })
    );
  }

  /**
   * Get a widget's current value (for text inputs).
   */
  async getWidgetValue(widgetId: string): Promise<string> {
    contractRequire(this._systemCtx !== undefined, 'System context not set');
    return this.request<string>(
      request(this.id, this._systemCtx!.uiServerId, UI_INTERFACE, 'getWidgetValue', {
        widgetId,
      })
    );
  }

  /**
   * Destroy a window.
   */
  async destroyWindow(windowId: string): Promise<boolean> {
    contractRequire(this._systemCtx !== undefined, 'System context not set');
    return this.request<boolean>(
      request(this.id, this._systemCtx!.uiServerId, UI_INTERFACE, 'destroyWindow', {
        windowId,
      })
    );
  }

  /**
   * Get display info (width, height).
   */
  async getDisplayInfo(): Promise<{ width: number; height: number }> {
    contractRequire(this._systemCtx !== undefined, 'System context not set');
    return this.request<{ width: number; height: number }>(
      request(this.id, this._systemCtx!.uiServerId, UI_INTERFACE, 'getDisplayInfo', {})
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
   */
  private compileAndInstall(source: string): void {
    const handlerMap = new Function('return ' + source)() as Record<string, MessageHandlerFn>;
    contractRequire(
      typeof handlerMap === 'object' && handlerMap !== null,
      'Handler source must evaluate to a non-null object'
    );

    for (const [method, fn] of Object.entries(handlerMap)) {
      if (typeof fn === 'function') {
        this.on(method, fn.bind(this));
        this._userMethods.add(method);
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

    // Remove old user handlers
    for (const method of this._userMethods) {
      this.off(method);
    }
    this._userMethods.clear();

    // Install new handlers bound to this instance
    for (const [method, fn] of Object.entries(handlerMap)) {
      if (typeof fn === 'function') {
        this.on(method, fn.bind(this));
        this._userMethods.add(method);
      }
    }

    this._source = source;
    return { success: true };
  }
}
