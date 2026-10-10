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
 *
 * Durable data (`persist`) goes where a ScriptableAbject's saveData goes, so
 * it outlives a backend restart and comes back as `data` in abject_init:
 * - an abject from an installed package (owner `package:<name>`) in a
 *   workspace: that workspace's AbjectStore, under `package/<Type>`
 *   (WorkspaceManager hands it back at the next spawn);
 * - one at system scope (no AbjectStore there): the Packages service, read
 *   before the guest is initialized;
 * - any other WASM abject: its workspace's AbjectStore, as a user object
 *   snapshot that the store restores at boot.
 * Saves are coalesced (at most one in flight, one queued, a second apart),
 * and every save also keeps the Registry registration current for respawn
 * and clone.
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
import { isPackageOwner } from '../core/packages.js';
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

/** Durable saves start at most this often; persists in between coalesce
 *  into the next one (same spacing as ScriptableAbject.saveData). */
const SAVE_MIN_INTERVAL_MS = 1000;

/** How long a system-scope package abject keeps asking Packages for its
 *  saved data before it starts the guest without it. */
const PACKAGE_DATA_WAIT_MS = 30 * 1000;

/**
 * How a WASM abject answers `ask`. The guest never sees ask (the host answers
 * it from the manifest), so its package supplies the usage guide and tier.
 */
export interface WasmAskGuidance {
  /** Markdown appended to the generic ask prompt. */
  guide?: string;
  tier?: 'smart' | 'balanced' | 'fast';
}

export interface WasmAbjectArgs {
  manifest: AbjectManifest;
  /** wasm source ref: `wasm:sha256:<hex>` resolved via the module store. */
  source: string;
  owner?: AbjectId;
  data?: Record<string, unknown>;
  ask?: WasmAskGuidance;
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

/** True when a request failed because its recipient no longer exists. */
function isRecipientGone(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /RECIPIENT_NOT_FOUND|is not registered/.test(message);
}

export class WasmAbject extends Abject {
  /** wasm source ref — persisted in Registry/AbjectStore like JS source. */
  readonly source: string;
  readonly owner: AbjectId;
  private readonly askGuidance?: WasmAskGuidance;

  /** The guest, set once abject_init has run. */
  private instance?: WasmInstance;
  /** A system-scope package's guest, instantiated and waiting for its data. */
  private pendingInstance?: WasmInstance;
  /** Why the guest could not be started after onInit, when it could not. */
  private startFailure?: string;
  private _data?: Record<string, unknown>;

  /** The AbjectStore that keeps this abject's durable data (workspace). */
  private storeId?: AbjectId;
  /** Set for a package abject at system scope: Packages keeps its data. */
  private packagesId?: AbjectId;
  /** Whether Packages' copy has been read. Until it has, nothing is written
   *  there, so a fresh guest's state can never replace the saved data. */
  private packageDataLoaded = false;

  // Coalesced persist state: one save in flight, one queued.
  private saveDirty = false;
  private saveInFlight = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private lastSaveStart = 0;

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
    this.askGuidance = args.ask;

    // A recipient this object addressed by name is gone: forget its cached
    // id so the next request resolves the name afresh. The guest still
    // receives the notice.
    this.on('recipientGone', (msg: AbjectMessage) => {
      const gone = (msg.payload as { recipient?: string } | undefined)?.recipient;
      for (const [name, id] of this.targetCache) if (id === gone) this.targetCache.delete(name);
      return this.dispatchToGuest(msg);
    });

    // Everything not handled by the base class (describe/ping/ask/dependents)
    // goes to the guest.
    this.on('*', (msg: AbjectMessage) => this.dispatchToGuest(msg));
  }

  protected override askPrompt(question: string): string {
    const base = super.askPrompt(question);
    return this.askGuidance?.guide ? `${base}\n\n${this.askGuidance.guide}` : base;
  }

  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return this.askGuidance?.tier ?? super.askTier();
  }

  /** Current durable data (guest snapshot when available). Mirrors
   *  ScriptableAbject.dataSnapshot for Factory registration payloads. */
  get dataSnapshot(): Record<string, unknown> | undefined {
    return this.instance?.snapshot() ?? this._data;
  }

  /** Whether this abject came from an installed package. */
  private get fromPackage(): boolean {
    return isPackageOwner(this.owner);
  }

  protected override async onInit(): Promise<void> {
    const bytes = await loadWasmModule(this.source);

    const instance = await WasmInstance.create(bytes, {
      objectId: this.id,
      onLog: (level, message) => this.hostLog(level, message),
    });

    // The module self-describes; a drifted install manifest is a packaging
    // bug worth surfacing, but the spawn-time manifest stays authoritative
    // for this instance (the Registry already has it).
    const declared = instance.manifest();
    if (declared.name !== this.manifest.name) {
      log.warn(`module declares name '${declared.name}' but was spawned as '${this.manifest.name}' (${this.source.slice(0, 30)}...)`);
    }

    // A package abject keeps its data where its scope does: a workspace has
    // an AbjectStore, the system level has none, so there Packages keeps it.
    // (The same split as ScriptableAbject.) Messages that arrive meanwhile
    // wait in the early queue: the guest is not started yet.
    if (this.fromPackage) {
      this.storeId = await this.discoverDep('AbjectStore') ?? undefined;
      if (!this.storeId) this.packagesId = await this.discoverDep('Packages') ?? undefined;
    }

    if (this.packagesId) {
      // Packages answers only an abject it finds registered as the
      // package's own, and the Factory registers this one after onInit
      // returns, so the guest starts once that data has been read.
      this.pendingInstance = instance;
      void this.startWithPackageData();
    } else {
      this.startGuest(instance);
    }

    this.checkInvariants();
  }

  /** Run abject_init with the current data, then drain the early queue. */
  private startGuest(instance: WasmInstance): void {
    const startup = instance.init({
      objectId: this.id,
      typeId: this.typeId,
      name: this.manifest.name,
      data: this._data,
      now: Date.now(),
    });
    this.instance = instance;
    this.processEnvelopes(startup);

    // Drain messages that raced instantiation.
    const queued = this.earlyQueue;
    this.earlyQueue = [];
    for (const msg of queued) {
      this.completeDeferred(msg, instance.handle({ kind: 'message', message: msg }));
    }
  }

  /**
   * A system-scope package abject: read the data Packages keeps for it, then
   * start the guest with it. The first asks can come before the Factory has
   * registered this object, which Packages refuses, so it asks again with a
   * growing delay. If no answer comes within PACKAGE_DATA_WAIT_MS the guest
   * starts with the data it was spawned with (a respawn's Registry copy), and
   * its persists are not written to Packages this run, so the stored data is
   * never replaced by state that did not start from it.
   */
  private async startWithPackageData(): Promise<void> {
    const packagesId = this.packagesId!;
    const deadline = Date.now() + PACKAGE_DATA_WAIT_MS;
    let lastError = '';
    for (let delay = 25; this.pendingInstance; delay = Math.min(delay * 2, 2000)) {
      try {
        const stored = await this.request<Record<string, unknown> | null>(
          request(this.id, packagesId, 'getPackageData', {}));
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) this._data = stored;
        this.packageDataLoaded = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const instance = this.pendingInstance;
    if (!instance) return; // stopped while waiting
    this.pendingInstance = undefined;
    if (!this.packageDataLoaded) {
      log.warn(`[${this.manifest.name}] could not read its saved package data (${lastError}); ` +
        'starting without it, and its persists stay in memory this run');
    }

    try {
      this.startGuest(instance);
    } catch (err) {
      // The spawn already succeeded, so there is nobody to throw to: fail
      // what is waiting and everything that arrives later.
      this.startFailure = err instanceof Error ? err.message : String(err);
      log.error(`[${this.manifest.name}] guest failed to start: ${this.startFailure}`);
      const queued = this.earlyQueue;
      this.earlyQueue = [];
      for (const msg of queued) {
        if (!isRequest(msg)) continue;
        try { this.send(error(msg, 'START_FAILED', this.startFailure)); } catch { /* stopped */ }
      }
    }
    this.checkInvariants();
  }

  protected override async onStop(): Promise<void> {
    // Write a queued persist before the guest goes away. Status is already
    // 'stopped', so request() is refused and no reply could come back: the
    // save goes out as a fire-and-forget event (as ScriptableAbject does).
    if (this.saveDirty || this.saveTimer !== undefined) {
      this.cancelTimer(this.saveTimer);
      this.saveTimer = undefined;
      this.saveDirty = false;
      try { this.finalSave(); } catch { /* best effort at shutdown */ }
    }
    // Drop the instance; pending callers are rejected by base stop().
    this.instance = undefined;
    this.pendingInstance = undefined;
    this.pendingInbound.clear();
    this.earlyQueue = [];
  }

  // ── Inbound: bus → guest ───────────────────────────────────────────────

  private dispatchToGuest(msg: AbjectMessage): unknown {
    this.prunePendingInbound();

    if (this.startFailure) {
      if (!isRequest(msg)) return undefined;
      throw new Error(`START_FAILED: ${this.startFailure}`);
    }

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
        const send = async () => this.request(
          request(this.id, await this.resolveTarget(env.to), env.method, env.payload ?? {}),
          env.timeoutMs ?? 30000,
        );
        try {
          payload = await send();
        } catch (err) {
          // A named target can be respawned under a new id (a restart, a
          // worker recovery); the cached id then points at nobody. Resolve
          // the name again and retry once rather than failing every later
          // request to it.
          if (!env.to.startsWith('@') || !isRecipientGone(err)) throw err;
          this.targetCache.delete(env.to.slice(1));
          payload = await send();
        }
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

  // ── Durable data (persist) ─────────────────────────────────────────────

  /**
   * A guest `persist`. Coalesced: at most one save is in flight and one is
   * queued, and saves start at least SAVE_MIN_INTERVAL_MS apart. A guest may
   * persist on every message; without coalescing each one would be a
   * snapshot across the WASM boundary plus a full AbjectStore write. The
   * snapshot is taken when the save starts, so it holds every change the
   * coalesced persists asked for.
   */
  private persistData(): void {
    if (!this.instance) return;
    this.saveDirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined || this.saveInFlight) return;
    const wait = Math.max(0, SAVE_MIN_INTERVAL_MS - (Date.now() - this.lastSaveStart));
    this.saveTimer = this.setTimer(() => this.flushSave(), wait);
  }

  private async flushSave(): Promise<void> {
    this.saveTimer = undefined;
    if (!this.saveDirty || !this.instance) return;
    this.saveDirty = false;
    this.saveInFlight = true;
    this.lastSaveStart = Date.now();
    try {
      await this.saveNow();
    } catch (err) {
      log.warn(`[${this.manifest.name}] persist failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.saveInFlight = false;
    }
    // A persist that arrived during the save is waiting for the next one.
    if (this.saveDirty && this.instance) this.scheduleSave();
  }

  /** Snapshot the guest and write the data where this abject keeps it. */
  private async saveNow(): Promise<void> {
    const snapshot = this.instance?.snapshot();
    if (snapshot === undefined) return; // the guest keeps no durable data
    this._data = snapshot;

    if (this.packagesId) {
      // System scope: Packages keeps the durable copy; the Registry's is
      // what a supervised restart starts from.
      this.upsertRegistration();
      if (!this.packageDataLoaded) return; // see startWithPackageData
      await this.request(request(this.id, this.packagesId, 'savePackageData', { data: snapshot }));
      return;
    }

    this.storeId ??= await this.discoverDep('AbjectStore') ?? undefined;
    if (!this.storeId) {
      // No AbjectStore where this abject lives (a non-package abject at
      // system scope): the Registry copy is all there is.
      this.upsertRegistration();
      return;
    }
    try {
      // The store records the data (a package abject's under
      // `package/<Type>`, anything else as a user snapshot) and updates the
      // Registry registration with it.
      await this.request(request(this.id, this.storeId, 'save', this.storePayload(snapshot)));
    } catch (err) {
      // The cached id may be stale (the store respawned): find it again
      // next time, and keep the Registry copy current meanwhile.
      this.storeId = undefined;
      this.upsertRegistration();
      throw err;
    }
  }

  /** The last save, at stop: fire-and-forget, since no reply can come back. */
  private finalSave(): void {
    const snapshot = this.instance?.snapshot();
    if (snapshot === undefined) return;
    this._data = snapshot;
    if (this.packagesId) {
      if (this.packageDataLoaded) {
        this.send(event(this.id, this.packagesId, 'savePackageData', { data: snapshot }));
      }
    } else if (this.storeId) {
      this.send(event(this.id, this.storeId, 'save', this.storePayload(snapshot)));
    }
  }

  private storePayload(data: Record<string, unknown>): Record<string, unknown> {
    return {
      objectId: this.id,
      manifest: this.manifest,
      source: this.source,
      owner: this.owner,
      data,
    };
  }

  /** Upsert our Registry registration with the current data so respawn,
   *  restore and clone see it. */
  private upsertRegistration(): void {
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
    } catch { /* bus unavailable: the Registry copy is best effort */ }
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
    invariant(!(this.instance && this.pendingInstance), 'a guest is either started or waiting, never both');
    invariant(!this.packagesId || this.fromPackage, 'only a package abject keeps its data with Packages');
  }
}
