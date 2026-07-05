/**
 * CapabilityInterceptor — bus-level capability enforcement for source-backed
 * objects (ScriptableAbjects and Organisms).
 *
 * What is enforced: when a SOURCE-BACKED object (its registration carries
 * source code) sends a request to a target that declares a non-empty
 * `providedCapabilities`, the sender's manifest `requiredCapabilities` must
 * include at least one of the target's provided capability IDs. The manifest
 * is authored and reviewed in the object-creation pipeline, so it is the
 * declaration of intent this check holds objects to.
 *
 * What is exempt:
 * - System objects (no source in their registration) are never restricted.
 * - Targets that provide no capabilities are never restricted.
 * - Introspection and observation stay open to everyone: describe, ask,
 *   addDependent, removeDependent, getValue.
 * - Replies, errors, and events pass through untouched; only requests are
 *   examined.
 *
 * Why WASM objects are not handled here: the WASM sandbox enforces
 * capabilities at the import boundary (src/sandbox/wasm-imports.ts); a WASM
 * object physically lacks any host function it was not granted. This
 * interceptor closes the equivalent gap for JS objects, which share the
 * process and could otherwise message anything.
 *
 * Timing model: `intercept()` is synchronous (the bus never awaits), while
 * registration lookups are messages to the Registry/ObjectCatalog. Decisions
 * therefore come from a lazily warmed cache: the first request from an
 * unknown sender passes while its registration loads, and enforcement holds
 * from the next message on. Entries expire after 60 seconds so redeploys and
 * manifest updates are picked up.
 *
 * Modes: 'off' (inert), 'warn' (throttled structured log, message passes),
 * 'enforce' (request is replaced with a CAPABILITY_DENIED error reply to the
 * sender naming the capability to declare). Default is 'warn'.
 */

import { AbjectId, AbjectMessage, ObjectRegistration } from '../core/types.js';
import { request as createRequest, error as createError } from '../core/message.js';
import { MessageBus, MessageInterceptor } from './message-bus.js';
import { Mailbox } from './mailbox.js';
import { Log } from '../core/timed-log.js';

const log = new Log('CapabilityInterceptor');

export type CapabilityEnforcementMode = 'off' | 'warn' | 'enforce';

const CACHE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const SNAPSHOT_MIN_INTERVAL_MS = 15_000;
const WARN_THROTTLE_MS = 300_000;
const LOOKUP_TIMEOUT_MS = 5_000;

/** Methods that stay open to every object regardless of capabilities. */
const OPEN_METHODS = new Set([
  'describe', 'ask', 'addDependent', 'removeDependent', 'getValue',
]);

interface CachedInfo {
  isSourceBacked: boolean;
  requiredCapabilityIds: Set<string>;
  providedCapabilityIds: string[];
  cachedAt: number;
  ttlMs: number;
}

/** Normalize manifest.requiredCapabilities entries (objects or bare ids). */
function requiredIds(reg: ObjectRegistration): Set<string> {
  const out = new Set<string>();
  for (const entry of reg.manifest?.requiredCapabilities ?? []) {
    if (typeof entry === 'string') out.add(entry);
    else if (entry && typeof entry.capability === 'string') out.add(entry.capability);
  }
  return out;
}

export class CapabilityInterceptor implements MessageInterceptor {
  private mode: CapabilityEnforcementMode = 'warn';
  private readonly selfId: AbjectId;
  private readonly mailbox: Mailbox;
  private running = true;

  private cache = new Map<AbjectId, CachedInfo>();
  private warming = new Set<AbjectId>();
  private pending = new Map<string, (msg: AbjectMessage) => void>();

  private catalogId?: AbjectId;
  private catalogUnavailable = false;
  private snapshotIndex = new Map<string, ObjectRegistration>();
  private snapshotFetchedAt = 0;
  private snapshotInFlight = false;

  private lastWarnAt = new Map<string, number>();

  constructor(
    private readonly registryId: AbjectId,
    private readonly bus: MessageBus,
  ) {
    this.selfId = `capability-interceptor-${globalThis.crypto.randomUUID()}` as AbjectId;
    this.mailbox = bus.register(this.selfId);
    void this.runReplyLoop();
  }

  setMode(mode: CapabilityEnforcementMode): void {
    if (mode !== 'off' && mode !== 'warn' && mode !== 'enforce') return;
    if (mode !== this.mode) log.info(`enforcement mode: ${this.mode} -> ${mode}`);
    this.mode = mode;
  }

  getMode(): CapabilityEnforcementMode {
    return this.mode;
  }

  /** Unregister the reply mailbox and stop background work. */
  stop(): void {
    this.running = false;
    try { this.bus.unregister(this.selfId); } catch { /* already gone */ }
  }

  // ── Interception (synchronous, never throws) ─────────────────────────

  intercept(message: AbjectMessage): 'pass' | AbjectMessage {
    if (this.mode === 'off') return 'pass';
    if (message.header.type !== 'request') return 'pass';

    const from = message.routing.from;
    const to = message.routing.to;
    if (!from || !to || from === this.selfId || to === this.selfId) return 'pass';
    if (OPEN_METHODS.has(message.routing.method ?? '')) return 'pass';

    try {
      const sender = this.getCached(from);
      if (!sender) {
        this.warm(from);
        return 'pass';
      }
      if (!sender.isSourceBacked) return 'pass';

      const target = this.getCached(to);
      if (!target) {
        this.warm(to);
        return 'pass';
      }
      if (target.providedCapabilityIds.length === 0) return 'pass';

      const satisfied = target.providedCapabilityIds.some(
        (id) => sender.requiredCapabilityIds.has(id));
      if (satisfied) return 'pass';

      const missing = target.providedCapabilityIds[0];
      const method = message.routing.method ?? '?';

      if (this.mode === 'warn') {
        this.throttledWarn(from, to, method, missing);
        return 'pass';
      }

      // enforce: the request is replaced with an error reply to the sender.
      return createError(
        message,
        'CAPABILITY_DENIED',
        `This object's manifest declares no capability for this target. ` +
        `Add '${missing}' to requiredCapabilities in the manifest and ` +
        `redeploy via the object editor to use method '${method}'.`,
        { missingCapability: missing, target: to },
      );
    } catch {
      // Enforcement is best-effort: any internal failure lets traffic flow.
      return 'pass';
    }
  }

  private throttledWarn(from: AbjectId, to: AbjectId, method: string, missing: string): void {
    const key = `${from}->${to}`;
    const now = Date.now();
    const last = this.lastWarnAt.get(key) ?? 0;
    if (now - last < WARN_THROTTLE_MS) return;
    this.lastWarnAt.set(key, now);
    log.warn(
      `capability gap: sender=${from.slice(0, 8)} target=${to.slice(0, 8)} ` +
      `method=${method} missing=${missing} (declare it in requiredCapabilities)`);
  }

  // ── Cache ─────────────────────────────────────────────────────────────

  private getCached(id: AbjectId): CachedInfo | undefined {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(id);
      return undefined;
    }
    return entry;
  }

  private warm(id: AbjectId): void {
    if (this.warming.has(id)) return;
    this.warming.add(id);
    void this.resolve(id)
      .then((reg) => {
        if (reg) {
          this.cache.set(id, {
            isSourceBacked: !!reg.source,
            requiredCapabilityIds: requiredIds(reg),
            providedCapabilityIds: [...(reg.manifest?.providedCapabilities ?? [])],
            cachedAt: Date.now(),
            ttlMs: CACHE_TTL_MS,
          });
        } else {
          // Unknown objects are treated as unrestricted for a short window,
          // then re-checked. Registration usually lands within seconds.
          this.cache.set(id, {
            isSourceBacked: false,
            requiredCapabilityIds: new Set(),
            providedCapabilityIds: [],
            cachedAt: Date.now(),
            ttlMs: NEGATIVE_TTL_MS,
          });
        }
      })
      .catch(() => { /* leave uncached; retried on next message */ })
      .finally(() => this.warming.delete(id));
  }

  private async resolve(id: AbjectId): Promise<ObjectRegistration | null> {
    // Global registry first (system objects and globally registered ones).
    const direct = await this.lookupInRegistry(id);
    if (direct) return direct;

    // Workspace-registered objects live in per-workspace registries the
    // global Registry cannot see; ObjectCatalog caches all of them.
    await this.refreshSnapshotIfStale();
    return this.snapshotIndex.get(id as string) ?? null;
  }

  private async lookupInRegistry(id: AbjectId): Promise<ObjectRegistration | null> {
    try {
      const reply = await this.requestOnce(
        createRequest(this.selfId, this.registryId, 'lookup', { objectId: id }));
      if (reply.header.type !== 'reply') return null;
      return (reply.payload as ObjectRegistration | null) ?? null;
    } catch {
      return null;
    }
  }

  private async refreshSnapshotIfStale(): Promise<void> {
    if (this.catalogUnavailable) return;
    if (this.snapshotInFlight) return;
    if (Date.now() - this.snapshotFetchedAt < SNAPSHOT_MIN_INTERVAL_MS) return;
    this.snapshotInFlight = true;
    try {
      if (!this.catalogId) {
        const reply = await this.requestOnce(
          createRequest(this.selfId, this.registryId, 'discover', { name: 'ObjectCatalog' }));
        const results = reply.header.type === 'reply'
          ? (reply.payload as ObjectRegistration[] | null) : null;
        if (!results || results.length === 0) {
          // The catalog spawns at bootstrap; absence past that point means
          // this deployment runs without it. Skip quietly from then on.
          this.catalogUnavailable = this.snapshotFetchedAt > 0;
          return;
        }
        this.catalogId = results[0].id;
      }
      const snap = await this.requestOnce(
        createRequest(this.selfId, this.catalogId, 'getSnapshot', {}));
      if (snap.header.type === 'reply') {
        const payload = snap.payload as {
          objects?: Array<[string, ObjectRegistration[]]>;
        } | null;
        const next = new Map<string, ObjectRegistration>();
        for (const [, regs] of payload?.objects ?? []) {
          for (const reg of regs) next.set(reg.id as string, reg);
        }
        this.snapshotIndex = next;
        this.snapshotFetchedAt = Date.now();
      }
    } catch {
      /* catalog unreachable; retried after the interval */
    } finally {
      this.snapshotInFlight = false;
    }
  }

  // ── Minimal request/reply plumbing over the interceptor's own mailbox ─

  private async requestOnce(msg: AbjectMessage): Promise<AbjectMessage> {
    return new Promise<AbjectMessage>((resolve, reject) => {
      const messageId = msg.header.messageId;
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error('capability lookup timed out'));
      }, LOOKUP_TIMEOUT_MS);
      this.pending.set(messageId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      try {
        this.bus.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(messageId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async runReplyLoop(): Promise<void> {
    while (this.running) {
      let msg: AbjectMessage;
      try {
        msg = await this.mailbox.receive();
      } catch {
        break; // mailbox closed
      }
      const correlationId = msg.header.correlationId;
      if (!correlationId) {
        this.maybeApplyModeEvent(msg);
        continue;
      }
      const waiter = this.pending.get(correlationId);
      if (waiter) {
        this.pending.delete(correlationId);
        waiter(msg);
      } else {
        this.maybeApplyModeEvent(msg);
      }
    }
  }

  /**
   * Apply a GlobalSettings enforcement-mode change delivered to our mailbox.
   * The bootstrap registers this interceptor as a GlobalSettings dependent, so
   * `changed` events with the capabilityEnforcementChanged aspect land here.
   */
  private maybeApplyModeEvent(msg: AbjectMessage): void {
    const p = msg.payload as { aspect?: string; value?: unknown } | undefined;
    if (p?.aspect === 'capabilityEnforcementChanged'
        && (p.value === 'off' || p.value === 'warn' || p.value === 'enforce')) {
      this.setMode(p.value);
    }
  }

  /** Bus id of the interceptor's own mailbox (for dependent registration). */
  get mailboxId(): AbjectId {
    return this.selfId;
  }
}

/** Create a capability interceptor bound to the global Registry and bus. */
export function createCapabilityInterceptor(
  registryId: AbjectId,
  bus: MessageBus,
): CapabilityInterceptor {
  return new CapabilityInterceptor(registryId, bus);
}
