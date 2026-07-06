/**
 * WasmAbject - an Abject whose behavior lives in a WebAssembly module.
 *
 * The host side of docs/WASM_ABI.md. Like ScriptableAbject wraps a JS source
 * string, WasmAbject wraps a compiled module referenced by a wasm source ref
 * (`wasm:sha256:<hex>` in the module store). Because it is an ordinary Abject
 * it rides everything the runtime already provides: mailbox, bus routing,
 * Registry registration, typeId identity, Supervisor restarts, worker-thread
 * placement, describe/introspect, and P2P reachability.
 *
 * Message flow:
 * - Inbound requests/events hit the '*' wildcard handler and are forwarded to
 *   the guest's abject_handle as `message` envelopes. The guest replies with
 *   a `reply`/`error` envelope, either synchronously (same call) or deferred
 *   (a later call, e.g. after one of its own requests completes).
 * - Guest-initiated requests are bridged through this.request() so replies
 *   flow through the normal pending-reply machinery, then delivered back to
 *   the guest as `result` envelopes. Targets may be '@Name' for Registry
 *   discovery (cached).
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  MessageId,
} from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { require, requireNonEmpty, invariant } from '../core/contracts.js';
import { request, event, error, isRequest } from '../core/message.js';
import { INTROSPECT_METHODS, INTROSPECT_EVENTS } from '../core/introspect.js';
import { Log } from '../core/timed-log.js';
import { WasmInstance } from '../sandbox/wasm-instance.js';
import { loadWasmModule, isWasmSourceRef } from '../sandbox/wasm-module-store.js';
import {
  OutboundEnvelope,
  ErrorEnvelope,
  RequestEnvelope,
  EventEnvelope,
} from '../sandbox/wasm-abi.js';

const log = new Log('WASM-ABJECT');

/** Constructor name registered with the Factory and the worker. */
export const WASM_ABJECT_CONSTRUCTOR = 'WasmAbject';

/** Deferred inbound requests older than this are dropped (callers have long
 *  since timed out). */
const PENDING_INBOUND_TTL_MS = 10 * 60 * 1000;

export interface WasmAbjectArgs {
  manifest: AbjectManifest;
  /** wasm source ref: `wasm:sha256:<hex>` resolved via the module store. */
  source: string;
  owner?: AbjectId;
  data?: Record<string, unknown>;
}

/**
 * Merge the standard introspect surface into a WASM module's manifest and tag
 * it 'wasm'. Mirrors mergeScriptableManifest so registrations made from the
 * main thread (worker-hosted spawns) match what the instance itself declares.
 */
export function mergeWasmManifest(manifest: AbjectManifest): AbjectManifest {
  require(manifest.interface !== undefined, 'wasm manifest must declare an interface');
  const iface = manifest.interface;
  const hasDescribe = iface.methods.some((m) => m.name === 'describe');
  const tags = manifest.tags?.includes('wasm')
    ? manifest.tags
    : [...(manifest.tags ?? []), 'wasm'];

  return {
    ...manifest,
    tags,
    interface: hasDescribe
      ? iface
      : {
          ...iface,
          methods: [...iface.methods, ...INTROSPECT_METHODS],
          events: [...(iface.events ?? []), ...INTROSPECT_EVENTS],
        },
  };
}

export class WasmAbject extends Abject {
  /** wasm source ref — persisted in Registry/AbjectStore like JS source. */
  readonly source: string;
  readonly owner: AbjectId;

  private instance?: WasmInstance;
  private _data?: Record<string, unknown>;

  /** Inbound requests awaiting a deferred guest reply. */
  private pendingInbound: Map<MessageId, { msg: AbjectMessage; at: number }> = new Map();
  /** Messages that arrived before the module finished instantiating. */
  private earlyQueue: AbjectMessage[] = [];
  /** '@Name' target resolution cache. */
  private targetCache: Map<string, AbjectId> = new Map();

  constructor(args: WasmAbjectArgs) {
    require(args.manifest !== undefined, 'manifest is required');
    requireNonEmpty(args.source, 'source');
    require(isWasmSourceRef(args.source), `source must be a wasm ref, got: ${args.source.slice(0, 40)}`);

    super({ manifest: mergeWasmManifest(args.manifest) });

    this.source = args.source;
    this.owner = args.owner ?? ('' as AbjectId);
    this._data = args.data;

    // Everything not handled by the base class (describe/ping/ask/dependents)
    // goes to the guest.
    this.on('*', (msg: AbjectMessage) => this.dispatchToGuest(msg));
  }

  /** Current durable data (guest snapshot when available). Mirrors
   *  ScriptableAbject.dataSnapshot for Factory registration payloads. */
  get dataSnapshot(): Record<string, unknown> | undefined {
    return this.instance?.snapshot() ?? this._data;
  }

  protected override async onInit(): Promise<void> {
    const bytes = await loadWasmModule(this.source);

    this.instance = await WasmInstance.create(bytes, {
      objectId: this.id,
      capabilities: this.capabilities,
      onLog: (level, message) => this.hostLog(level, message),
    });

    // The module self-describes; a drifted install manifest is a packaging
    // bug worth surfacing, but the spawn-time manifest stays authoritative
    // for this instance (the Registry already has it).
    const declared = this.instance.manifest();
    if (declared.name !== this.manifest.name) {
      log.warn(`module declares name '${declared.name}' but was spawned as '${this.manifest.name}' (${this.source.slice(0, 30)}...)`);
    }

    const startup = this.instance.init({
      objectId: this.id,
      typeId: this.typeId,
      name: this.manifest.name,
      data: this._data,
      now: Date.now(),
    });
    this.processEnvelopes(startup);

    // Drain messages that raced instantiation.
    const queued = this.earlyQueue;
    this.earlyQueue = [];
    for (const msg of queued) {
      this.completeDeferred(msg, this.instance.handle({ kind: 'message', message: msg }));
    }

    this.checkInvariants();
  }

  protected override async onStop(): Promise<void> {
    // Drop the instance; pending callers are rejected by base stop().
    this.instance = undefined;
    this.pendingInbound.clear();
    this.earlyQueue = [];
  }

  // ── Inbound: bus → guest ───────────────────────────────────────────────

  private dispatchToGuest(msg: AbjectMessage): unknown {
    this.prunePendingInbound();

    if (!this.instance) {
      // Module still instantiating — park the message and reply when ready.
      this.earlyQueue.push(msg);
      return isRequest(msg) ? DEFERRED_REPLY : undefined;
    }

    const out = this.instance.handle({ kind: 'message', message: msg });
    const outcome = this.processEnvelopes(out, msg);

    if (!isRequest(msg)) return undefined;

    if (outcome.error) {
      throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
    }
    if (outcome.replied) {
      return outcome.value ?? null;
    }

    // No reply yet — the guest will produce one from a later handle() call.
    this.pendingInbound.set(msg.header.messageId, { msg, at: Date.now() });
    return DEFERRED_REPLY;
  }

  /** Process guest output for a message that was parked in the early queue:
   *  its auto-reply was already suppressed, so sync replies go out deferred. */
  private completeDeferred(msg: AbjectMessage, out: OutboundEnvelope[]): void {
    const outcome = this.processEnvelopes(out, msg);
    if (!isRequest(msg)) return;

    if (outcome.error) {
      this.send(error(msg, outcome.error.code, outcome.error.message));
    } else if (outcome.replied) {
      this.sendDeferredReply(msg, outcome.value ?? null);
    } else {
      this.pendingInbound.set(msg.header.messageId, { msg, at: Date.now() });
    }
  }

  // ── Guest output processing ────────────────────────────────────────────

  /**
   * Apply every outbound envelope. When `current` is given, a reply/error
   * correlated to it is captured in the returned outcome instead of being
   * sent (the caller owns that request's reply path).
   */
  private processEnvelopes(
    envelopes: OutboundEnvelope[],
    current?: AbjectMessage,
  ): { replied: boolean; value?: unknown; error?: ErrorEnvelope } {
    const outcome: { replied: boolean; value?: unknown; error?: ErrorEnvelope } = {
      replied: false,
    };

    for (const env of envelopes) {
      switch (env.kind) {
        case 'reply':
        case 'error': {
          if (current && env.correlationId === current.header.messageId) {
            outcome.replied = true;
            if (env.kind === 'reply') outcome.value = env.payload;
            else outcome.error = env;
            break;
          }
          const pending = this.pendingInbound.get(env.correlationId);
          if (!pending) {
            log.warn(`[${this.manifest.name}] guest replied to unknown request ${env.correlationId}`);
            break;
          }
          this.pendingInbound.delete(env.correlationId);
          try {
            if (env.kind === 'reply') {
              this.sendDeferredReply(pending.msg, env.payload ?? null);
            } else {
              this.send(error(pending.msg, env.code, env.message));
            }
          } catch { /* stopped mid-flight */ }
          break;
        }

        case 'request':
          this.bridgeRequest(env);
          break;

        case 'event':
          this.bridgeEvent(env);
          break;

        case 'changed':
          this.changed(env.aspect, env.value);
          break;

        case 'persist':
          this.persistData();
          break;

        case 'log':
          this.hostLog({ debug: 0, info: 1, warn: 2, error: 3 }[env.level] ?? 1, env.message);
          break;
      }
    }

    return outcome;
  }

  /** Perform a guest-initiated request and feed the result back in. */
  private bridgeRequest(env: RequestEnvelope): void {
    void (async () => {
      let ok = false;
      let payload: unknown;
      let code = 'REQUEST_FAILED';
      let message = '';

      try {
        const target = await this.resolveTarget(env.to);
        payload = await this.request(
          request(this.id, target, env.method, env.payload ?? {}),
          env.timeoutMs ?? 30000,
        );
        ok = true;
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        const m = /^([A-Z][A-Z0-9_]{2,}): (.+)$/s.exec(message);
        if (m) {
          code = m[1];
          message = m[2];
        }
      }

      if (!this.instance) return; // stopped while in flight

      const out = this.instance.handle(
        ok
          ? { kind: 'result', id: env.id, ok: true, payload }
          : { kind: 'result', id: env.id, ok: false, code, message },
      );
      this.processEnvelopes(out);
    })();
  }

  private bridgeEvent(env: EventEnvelope): void {
    void (async () => {
      try {
        const target = await this.resolveTarget(env.to);
        this.send(event(this.id, target, env.method, env.payload ?? {}));
      } catch (err) {
        log.warn(`[${this.manifest.name}] event to '${env.to}' dropped: ${err instanceof Error ? err.message : err}`);
      }
    })();
  }

  /** Resolve '@Name' targets through the Registry (cached); pass ids through. */
  private async resolveTarget(to: string): Promise<AbjectId> {
    requireNonEmpty(to, 'envelope target');
    if (!to.startsWith('@')) return to as AbjectId;

    const name = to.slice(1);
    const cached = this.targetCache.get(name);
    if (cached) return cached;

    const id = await this.discoverDep(name);
    if (!id) throw new Error(`TARGET_NOT_FOUND: no object named '${name}' in Registry`);
    this.targetCache.set(name, id);
    return id;
  }

  /** Snapshot guest data and upsert it into our Registry registration so
   *  respawn/restore/clone see it. */
  private persistData(): void {
    if (!this.instance) return;

    const snapshot = this.instance.snapshot();
    if (snapshot !== undefined) this._data = snapshot;

    const regId = this.getRegistryId();
    if (!regId) return;

    try {
      this.send(
        request(this.id, regId, 'register', {
          objectId: this.id,
          manifest: this.manifest,
          status: this.status,
          ...(this.owner ? { owner: this.owner } : {}),
          source: this.source,
          ...(this.typeId ? { typeId: this.typeId } : {}),
          ...(this._data !== undefined ? { data: this._data } : {}),
        }),
      );
    } catch { /* bus unavailable — persist is best effort */ }
  }

  private hostLog(level: number, message: string): void {
    const name = this.manifest.name;
    if (level >= 3) {
      log.error(`[${name}] ${message}`);
      try { this.logError(message); } catch { /* not initialized yet */ }
    } else if (level === 2) {
      log.warn(`[${name}] ${message}`);
      try { this.logWarn(message); } catch { /* not initialized yet */ }
    } else {
      log.info(`[${name}] ${message}`);
      try { this.logInfo(message); } catch { /* not initialized yet */ }
    }
  }

  private prunePendingInbound(): void {
    if (this.pendingInbound.size === 0) return;
    const cutoff = Date.now() - PENDING_INBOUND_TTL_MS;
    for (const [id, entry] of this.pendingInbound) {
      if (entry.at < cutoff) this.pendingInbound.delete(id);
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(isWasmSourceRef(this.source), 'source must remain a wasm ref');
  }
}
