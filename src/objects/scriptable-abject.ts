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
 * Handler functions run in a sandboxed vm context. A `this`-proxy shim
 * provides this.call(), this.dep(), this.find(), this.changed(), this.emit(),
 * and this.observe() without exposing the real Abject instance or Node.js APIs.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  MethodDeclaration,
  EventDeclaration,
  InterfaceId,
} from '../core/types.js';
import { Abject, MessageHandlerFn } from '../core/abject.js';
import { require as contractRequire } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { INTROSPECT_METHODS, INTROSPECT_EVENTS } from '../core/introspect.js';
import { validateCode, compileSandboxed } from '../core/sandbox.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ScriptableAbject');

/** Editable methods merged into every ScriptableAbject's interface */
const EDITABLE_METHODS: MethodDeclaration[] = [
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
  {
    name: 'probe',
    description: 'Validate that all dependencies referenced in source can be resolved',
    parameters: [],
    returns: {
      kind: 'object' as const,
      properties: {
        success: { kind: 'primitive' as const, primitive: 'boolean' as const },
        resolvedDeps: { kind: 'array' as const, elementType: { kind: 'primitive' as const, primitive: 'string' as const } },
        missingDeps: { kind: 'array' as const, elementType: { kind: 'primitive' as const, primitive: 'string' as const } },
        error: { kind: 'primitive' as const, primitive: 'string' as const },
      },
    },
  },
];

const EDITABLE_EVENTS: EventDeclaration[] = [
  {
    name: 'sourceUpdated',
    description: 'Emitted when source code is successfully updated',
    payload: { kind: 'object' as const, properties: {
      objectId: { kind: 'primitive' as const, primitive: 'string' as const },
      methods: { kind: 'array' as const, elementType: { kind: 'primitive' as const, primitive: 'string' as const } },
    }},
  },
];

/**
 * Compute the merged manifest for a ScriptableAbject without constructing one.
 * Merges editable methods/events and the 'scriptable' tag, matching the constructor logic.
 * Also merges introspect methods/events (same as Abject constructor).
 */
export function mergeScriptableManifest(manifest: AbjectManifest): AbjectManifest {
  const tags = [...(manifest.tags ?? [])];
  if (!tags.includes('scriptable')) tags.push('scriptable');

  const iface = manifest.interface;
  const allMethods = [...iface.methods, ...EDITABLE_METHODS];
  const allEvents = [...(iface.events ?? []), ...EDITABLE_EVENTS];

  // Also merge introspect methods/events (same as Abject constructor)
  const hasDescribe = allMethods.some(m => m.name === 'describe');
  const finalMethods = hasDescribe ? allMethods : [...allMethods, ...INTROSPECT_METHODS];
  const hasChildReady = allEvents.some(e => e.name === 'childReady');
  const finalEvents = hasChildReady ? allEvents : [...allEvents, ...INTROSPECT_EVENTS];

  return {
    ...manifest,
    interface: { ...iface, methods: finalMethods, events: finalEvents },
    tags,
  };
}

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
    const tags = [...(manifest.tags ?? [])];
    if (!tags.includes('scriptable')) {
      tags.push('scriptable');
    }

    // Merge editable methods and events into the single interface
    const iface = manifest.interface;
    super({
      manifest: {
        ...manifest,
        interface: {
          ...iface,
          methods: [...iface.methods, ...EDITABLE_METHODS],
          events: [...(iface.events ?? []), ...EDITABLE_EVENTS],
        },
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

  protected override askPrompt(question: string): string {
    let prompt = super.askPrompt(question);
    if (this._source) prompt += '\n\nSource code:\n' + this._source;
    prompt += '\n\nYou are this object. Your capabilities are exactly what the manifest and source code above describe. Answer questions based on your actual capabilities, not hypothetical ones.';
    return prompt;
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
   * Supports qualified names:
   *   'ObjectName'                    — local registry
   *   'workspace.ObjectName'          — specific local workspace
   *   'peer.workspace.ObjectName'     — remote peer's workspace
   */
  async find(name: string): Promise<AbjectId | null> {
    const parts = name.split('.');
    if (parts.length === 3) {
      return this.findInRemoteWorkspace(parts[0], parts[1], parts[2]);
    }
    if (parts.length === 2) {
      return this.findInLocalWorkspace(parts[0], parts[1]);
    }
    return this.discoverDep(name);
  }

  private async findInRemoteWorkspace(
    ownerName: string, workspaceName: string, objectName: string,
  ): Promise<AbjectId | null> {
    const cacheKey = `remote:${ownerName}.${workspaceName}.${objectName}`;
    if (cacheKey in this._depCache) return this._depCache[cacheKey];
    try {
      const wsrId = await this.discoverDep('WorkspaceShareRegistry');
      if (!wsrId) return null;
      const workspaces = await this.request<Array<{
        ownerName: string; name: string; registryId: string;
      }>>(request(this.id, wsrId, 'getDiscoveredWorkspaces', {}));
      const ws = workspaces.find(w => w.ownerName === ownerName && w.name === workspaceName);
      if (!ws) return null;
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, ws.registryId as AbjectId, 'discover', { name: objectName })
      );
      if (results.length > 0) {
        this._depCache[cacheKey] = results[0].id;
        return results[0].id;
      }
    } catch { /* peer offline */ }
    return null;
  }

  private async findInLocalWorkspace(
    workspaceName: string, objectName: string,
  ): Promise<AbjectId | null> {
    const cacheKey = `local:${workspaceName}.${objectName}`;
    if (cacheKey in this._depCache) return this._depCache[cacheKey];
    try {
      // Workspace registries are registered as "WorkspaceRegistry:<name>"
      const wsRegId = await this.discoverDep(`WorkspaceRegistry:${workspaceName}`);
      if (!wsRegId) return null;
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, wsRegId, 'discover', { name: objectName })
      );
      if (results.length > 0) {
        this._depCache[cacheKey] = results[0].id;
        return results[0].id;
      }
    } catch { /* workspace not found */ }
    return null;
  }

  private setupEditableHandlers(): void {
    this.on('getSource', () => {
      return this._source;
    });

    this.on('probe', async () => {
      // Extract dep('...') and find('...') references from source
      // Match both this.dep() and bare dep() forms
      const depPattern = /(?:this\.)?dep\(\s*['"]([^'"]+)['"]\s*\)/g;
      const findPattern = /(?:this\.)?find\(\s*['"]([^'"]+)['"]\s*\)/g;
      const depNames = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = depPattern.exec(this._source)) !== null) depNames.add(match[1]);
      while ((match = findPattern.exec(this._source)) !== null) depNames.add(match[1]);

      // Qualified names (containing dots) are validated at runtime, not probe time
      const qualifiedNames = new Set<string>();
      for (const name of depNames) {
        if (name.includes('.')) qualifiedNames.add(name);
      }
      for (const name of qualifiedNames) depNames.delete(name);

      const resolved: string[] = [...qualifiedNames];
      const missing: string[] = [];

      for (const name of depNames) {
        const id = await this.find(name);
        if (id) {
          resolved.push(name);
        } else {
          missing.push(name);
        }
      }

      if (missing.length > 0) {
        return {
          success: false,
          resolvedDeps: resolved,
          missingDeps: missing,
          error: `Missing dependencies: ${missing.join(', ')}`,
        };
      }
      return { success: true, resolvedDeps: resolved, missingDeps: [], error: '' };
    });

    this.on('updateSource', async (msg: AbjectMessage) => {
      const { source } = msg.payload as { source: string };
      if (msg.routing.from !== this._owner) {
        // Ownership may be stale after restart (ObjectCreator gets new ID each session).
        // Resolve the current ObjectCreator and AbjectEditor via registry and accept if the sender matches either.
        const creatorId = await this.discoverDep('ObjectCreator');
        const editorId = await this.discoverDep('AbjectEditor');
        if (msg.routing.from !== creatorId && msg.routing.from !== editorId) {
          log.warn(
            `updateSource rejected: ${msg.routing.from} is not owner ${this._owner}`
          );
          return { success: false, error: 'Only the owner can update source' };
        }
        // Adopt sender as owner
        this._owner = msg.routing.from;
      }

      // Hot-reload: tear down current UI via old hide() handler
      const currentHide = this.handlers.get('hide');
      if (currentHide) {
        try {
          await currentHide(msg);
        } catch (err) {
          log.warn(`${this.manifest.name} hide() during reload failed:`, err);
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
          log.warn(`${this.manifest.name} show() during reload failed:`, err);
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
   *
   * Options: { timeout?: number } — override the default 30s request timeout.
   * Long-running calls (e.g. WebAgent.runTask) should pass a longer timeout.
   *
   * Backward compat: detects 4-arg calls (to, interfaceId, method, payload)
   * from stored user objects and skips the second arg.
   */
  async call<T>(
    to: AbjectId | string | Promise<AbjectId>,
    method: string,
    payload?: unknown,
    options?: { timeout?: number } | unknown,
  ): Promise<T> {
    // Backward compat: if called with 4 args and the 2nd looks like an interface ID, skip it
    if (options !== undefined && typeof method === 'string' && typeof payload === 'string') {
      // Old call signature: call(to, interfaceId, method, payload)
      const actualMethod = payload as unknown as string;
      const actualPayload = options;
      const resolvedTo = await to;
      return this.request<T>(
        request(this.id, resolvedTo as AbjectId, actualMethod, actualPayload)
      );
    }
    const resolvedTo = await to;
    const timeoutMs = (options && typeof options === 'object' && 'timeout' in options)
      ? (options as { timeout?: number }).timeout
      : undefined;
    return this.request<T>(
      request(this.id, resolvedTo as AbjectId, method, payload ?? {}),
      timeoutMs,
    );
  }

  /**
   * Send an event (fire-and-forget) to another object.
   * The `to` parameter accepts a Promise (from this.dep()) or a plain ID.
   */
  async emit(to: AbjectId | string | Promise<AbjectId>, eventName: string, payload?: unknown): Promise<void> {
    const resolvedTo = await to;
    this.send(event(this.id, resolvedTo as AbjectId, eventName, payload ?? {}));
  }

  /**
   * Observe another object — call addDependent so this object receives
   * 'changed' events from the target. Define a 'changed' handler in your
   * source to process them.
   */
  async observe(target: AbjectId | string | Promise<AbjectId>): Promise<void> {
    const resolvedTarget = await target;
    await this.request(request(this.id, resolvedTarget as AbjectId, 'addDependent', {}));
  }

  // ── Compilation ───────────────────────────────────────────────────

  /**
   * Try to compile source without installing. Returns error message on failure, undefined on success.
   */
  static tryCompile(source: string): string | undefined {
    try {
      compileSandboxed(source, {});
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
  /**
   * Handlers auto-provided by the framework (Abject base + ScriptableAbject).
   * User code cannot override these; they are silently skipped during compile.
   * ObjectCreator imports this set to exclude them from verification and LLM prompts.
   */
  static readonly PROTECTED_HANDLERS = new Set([
    'getSource', 'updateSource', 'probe', 'windowCloseRequested',
    'describe', 'ask', 'getRegistry',
    'ping', 'addDependent', 'removeDependent',
  ]);

  /** Keys on the this-proxy that must not be overwritten by user handler code. */
  private static readonly PROXY_BUILTINS = new Set([
    'call', 'dep', 'find', 'changed', 'emit', 'observe', 'id',
  ]);

  /**
   * Build the `this`-proxy object that handler code sees as `this`.
   * Contains only safe helpers; no access to the real Abject or Node.js APIs.
   */
  private buildHandlerProxy(): Record<string, unknown> {
    const self = this;

    const callFn = async <T>(
      to: AbjectId | string | Promise<AbjectId>,
      method: string,
      payload?: unknown,
      options?: { timeout?: number } | unknown,
    ): Promise<T> => {
      // Backward compat: 4-arg call(to, interfaceId, method, payload)
      if (options !== undefined && typeof method === 'string' && typeof payload === 'string') {
        const actualMethod = payload as unknown as string;
        const actualPayload = options;
        const resolvedTo = await to;
        return self.request<T>(
          request(self.id, resolvedTo as AbjectId, actualMethod, actualPayload)
        );
      }
      const resolvedTo = await to;
      const timeoutMs = (options && typeof options === 'object' && 'timeout' in options)
        ? (options as { timeout?: number }).timeout
        : undefined;
      return self.request<T>(
        request(self.id, resolvedTo as AbjectId, method, payload ?? {}),
        timeoutMs,
      );
    };

    const depFn = async (name: string): Promise<AbjectId> => self.dep(name);
    const findFn = async (name: string): Promise<AbjectId | null> => self.find(name);
    const changedFn = (aspect: string, value?: unknown): void => self.changed(aspect, value);
    const emitFn = async (to: AbjectId | string | Promise<AbjectId>, eventName: string, payload?: unknown): Promise<void> => {
      const resolvedTo = await to;
      self.send(event(self.id, resolvedTo as AbjectId, eventName, payload ?? {}));
    };
    const observeFn = async (target: AbjectId | string | Promise<AbjectId>): Promise<void> => {
      const resolvedTarget = await target;
      await self.request(request(self.id, resolvedTarget as AbjectId, 'addDependent', {}));
    };

    const proxy: Record<string, unknown> = {
      call: callFn,
      dep: depFn,
      find: findFn,
      changed: changedFn,
      emit: emitFn,
      observe: observeFn,
    };
    // `id` must read live from the Abject so handler code that captures
    // `this.id` (e.g. `inputTargetId: this.id` on createCanvas) sees the
    // post-setId value. Worker spawn and snapshot restore both call
    // setId AFTER the constructor finishes, so a value-captured id would
    // be the stale constructor-time uuid and route messages to a dead id.
    Object.defineProperty(proxy, 'id', {
      enumerable: true,
      configurable: false,
      get: () => self.id,
    });
    return proxy;
  }

  private compileAndInstall(source: string): void {
    // Build the this-proxy with safe helpers
    const handlerThis = this.buildHandlerProxy();

    // Compile in sandboxed vm context. No access to require, process, fs, etc.
    // Security comes from both the vm sandbox (isolates Node.js globals) and the
    // this-proxy (restricts what handlers can access via `this`).
    // Performance: ScriptableAbject is worker-eligible, so cross-realm overhead
    // is contained within worker threads and does not block the main thread.
    const handlerMap = compileSandboxed(source, handlerThis, {
      filename: `scriptable-${this.manifest.name}.js`,
    }) as Record<string, MessageHandlerFn>;

    const baseProps = new Set(Object.keys(this));
    const proto = Object.getPrototypeOf(this);
    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        const bound = value.bind(handlerThis);
        // Don't overwrite base class methods or properties
        if (!(key in proto) && !baseProps.has(key)) {
          (this as Record<string, unknown>)[key] = bound;
        }
        // Store on proxy so handlers can call each other via this.method(),
        // but never overwrite proxy builtins (call, dep, find, changed, etc.)
        if (!ScriptableAbject.PROXY_BUILTINS.has(key)) {
          handlerThis[key] = bound;
        }
        if (!key.startsWith('_') && !ScriptableAbject.PROTECTED_HANDLERS.has(key)) {
          // Message handler -- also registered on bus
          this.on(key, bound);
          this._userMethods.add(key);
        }
      } else {
        // State property -- store on proxy so handler code sees this._state
        if (!ScriptableAbject.PROXY_BUILTINS.has(key)) {
          handlerThis[key] = value;
        }
        // Skip if it collides with a base class field
        if (baseProps.has(key)) {
          log.warn(`Skipping user property '${key}' -- collides with base class`);
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
  applySource(source: string): { success: boolean; error?: string; errorLine?: number } {
    // Build a fresh this-proxy and compile in sandbox
    const handlerThis = this.buildHandlerProxy();
    let handlerMap: Record<string, MessageHandlerFn>;
    try {
      handlerMap = compileSandboxed(source, handlerThis, {
        filename: `scriptable-${this.manifest.name}.js`,
      }) as Record<string, MessageHandlerFn>;
    } catch (err) {
      // Extract error line number from vm.Script stack trace
      let errorLine: number | undefined;
      const stack = (err as Error).stack ?? '';
      const match = stack.match(/evalmachine\.<anonymous>:(\d+)/);
      if (match) {
        errorLine = parseInt(match[1], 10) - 1; // subtract 1 for the function wrapper line
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        errorLine,
      };
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

    // Install new handlers and properties bound to the proxy
    const baseProps = new Set(Object.keys(this));
    const proto = Object.getPrototypeOf(this);
    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        const bound = value.bind(handlerThis);
        // Don't overwrite base class methods or properties
        if (!(key in proto) && !baseProps.has(key)) {
          (this as Record<string, unknown>)[key] = bound;
        }
        // Store on proxy so handlers can call each other via this.method(),
        // but never overwrite proxy builtins (call, dep, find, changed, etc.)
        if (!ScriptableAbject.PROXY_BUILTINS.has(key)) {
          handlerThis[key] = bound;
        }
        if (!key.startsWith('_') && !ScriptableAbject.PROTECTED_HANDLERS.has(key)) {
          // Message handler -- also registered on bus
          this.on(key, bound);
          this._userMethods.add(key);
        }
      } else {
        // State property -- store on proxy so handler code sees this._state
        if (!ScriptableAbject.PROXY_BUILTINS.has(key)) {
          handlerThis[key] = value;
        }
        // Skip if it collides with a base class field
        if (baseProps.has(key)) {
          log.warn(`Skipping user property '${key}' -- collides with base class`);
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
        'sourceUpdated',
        { objectId: this.id, methods: newMethods }
      )
    );

    return { success: true };
  }
}
