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
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject, MessageHandlerFn } from '../core/abject.js';
import { require as contractRequire } from '../core/contracts.js';

export const EDITABLE_INTERFACE_ID = 'abjects:editable' as InterfaceId;

/**
 * An Abject whose handlers are compiled from a JavaScript source string.
 * Supports live editing: new source can be applied at runtime without restarting.
 */
export class ScriptableAbject extends Abject {
  private _source: string;
  private _owner: AbjectId;
  private _userMethods: Set<string> = new Set();

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
        interfaces: [...manifest.interfaces, editableInterface],
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
   */
  private compileAndInstall(source: string): void {
    const handlerMap = new Function('return ' + source)() as Record<string, MessageHandlerFn>;
    contractRequire(
      typeof handlerMap === 'object' && handlerMap !== null,
      'Handler source must evaluate to a non-null object'
    );

    for (const [method, fn] of Object.entries(handlerMap)) {
      if (typeof fn === 'function') {
        this.on(method, fn);
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

    // Install new handlers
    for (const [method, fn] of Object.entries(handlerMap)) {
      if (typeof fn === 'function') {
        this.on(method, fn);
        this._userMethods.add(method);
      }
    }

    this._source = source;
    return { success: true };
  }
}
