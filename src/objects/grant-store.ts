/**
 * The grants PermissionBroker holds (docs/design/permission-modes.html §3.3-§5).
 *
 * This is plain state, not an Abject: only PermissionBroker constructs one,
 * and it is the broker that decides who may call which operation (settings
 * authorities mint roots, holders derive and set modes). The store enforces
 * the parts that do not depend on who asked: attenuation (rule 3), holder
 * binding on derive and setMode, liveness of the whole chain, and the meet
 * that gives a grant its effective mode (rule 4).
 *
 * A grant id is a holder-bound handle, not a bearer secret: lookups always
 * compare the presenting object with the grant's holder.
 */

import { invariant, require } from '../core/contracts.js';
import {
  attenuationViolation, ceilingMode, meetMode, modeAtMost, modeWithin, parseCeiling, parseMode,
  minReach as minOf, minBeyond as minB,
  DEFAULT_GRANT_TYPES,
  type Grant, type GrantReceipt, type ModeCeiling, type PermissionMode,
} from '../core/permission-modes.js';

export interface RootSpec {
  holder: string;
  holderLabel: string;
  workspaceId: string;
  mode: PermissionMode;
  ceiling: ModeCeiling;
  types?: string[];
  roots?: string[] | null;
  mayDerive?: number;
  maySetMode?: boolean;
  expiresAt?: number;
}

export interface DeriveSpec {
  holder: string;
  holderLabel?: string;
  taskId?: string;
  conversationId?: string;
  mode?: unknown;
  /** With no mode: follow the parent's effective mode live (goal and task grants). */
  inherit?: boolean;
  ceiling?: unknown;
  types?: string[];
  roots?: string[] | null;
  mayDerive?: number;
  maySetMode?: boolean;
  expiresAt?: number;
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_GRANTS = 5000;

export class GrantStore {
  private grants = new Map<string, Grant>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get size(): number { return this.grants.size; }

  get(id: string): Grant | undefined { return this.grants.get(id); }

  all(): Grant[] { return [...this.grants.values()]; }

  /** Live: not revoked, not expired, and every ancestor live too. */
  live(g: Grant): boolean {
    const t = this.now();
    for (const x of this.chain(g)) {
      if (x.revoked) return false;
      if (x.expiresAt !== undefined && x.expiresAt <= t) return false;
    }
    return true;
  }

  /** Root first, `g` last. A missing parent ends the walk (the grant is then orphaned and not live). */
  chain(g: Grant): Grant[] {
    const out: Grant[] = [g];
    let cur = g;
    const seen = new Set<string>([g.id]);
    while (cur.parent) {
      const p = this.grants.get(cur.parent);
      if (!p || seen.has(p.id)) {
        // An orphan is treated as revoked.
        return [{ ...g, revoked: true }];
      }
      seen.add(p.id);
      out.push(p);
      cur = p;
    }
    return out.reverse();
  }

  /**
   * Rule 4: the effective mode is the live meet of the chain. A root's mode is
   * only the default it hands to what it creates (the workspace's "default
   * mode"), so below the root its ceiling is what bounds the chain: a chat
   * the person raised to Auto is Auto while the workspace default is Manual.
   * An inheriting grant (a goal's, a task's) follows its parent live.
   */
  effective(g: Grant): PermissionMode {
    const chain = this.chain(g);
    if (chain.length === 1) return { ...chain[0].mode };
    let eff = ceilingMode(chain[0].ceiling);
    for (const x of chain.slice(1)) {
      eff = x.inherit ? meetMode(eff, ceilingMode(x.ceiling)) : meetMode(x.mode, eff);
    }
    return eff;
  }

  receipt(g: Grant): GrantReceipt {
    return { id: g.id, mode: this.effective(g), chain: this.chain(g).map(x => x.id) };
  }

  /** Mint or replace the root grant a holder has for a workspace. */
  mintRoot(spec: RootSpec): Grant {
    require(spec.holder.length > 0, 'a root grant needs a holder');
    require(modeWithin(spec.mode, spec.ceiling), 'a root mode must sit within its ceiling');
    const existing = this.all().find(g => !g.parent && g.holder === spec.holder && g.workspaceId === spec.workspaceId && !g.revoked);
    const g: Grant = {
      id: existing?.id ?? newGrantId(),
      holder: spec.holder,
      holderLabel: spec.holderLabel,
      workspaceId: spec.workspaceId,
      mode: { ...spec.mode },
      ceiling: { ...spec.ceiling },
      types: spec.types ? [...spec.types] : [...DEFAULT_GRANT_TYPES],
      roots: spec.roots === undefined ? null : spec.roots,
      mayDerive: spec.mayDerive ?? 3,
      maySetMode: spec.maySetMode ?? true,
      expiresAt: spec.expiresAt,
      revoked: false,
      createdAt: existing?.createdAt ?? this.now(),
    };
    const prev = existing ? { ...existing } : undefined;
    this.grants.set(g.id, g);
    // A narrower root narrows every live descendant at once through the meet;
    // ceilings below it must be clamped before check() so invariants hold and
    // callers (e.g. PermissionBroker.grantMode) reach persistence.
    if (existing) this.clampDescendants(g);
    try {
      this.check();
    } catch (err) {
      if (prev) this.grants.set(prev.id, prev);
      else this.grants.delete(g.id);
      throw err;
    }
    return g;
  }

  /** Rule 2 + 3: only the parent's holder derives, and never wider. */
  derive(parentId: string, caller: string, spec: DeriveSpec): StoreResult<Grant> {
    const parent = this.grants.get(parentId);
    if (!parent) return { ok: false, error: 'no such grant' };
    if (parent.holder !== caller) return { ok: false, error: 'grant not held by caller' };
    if (!this.live(parent)) return { ok: false, error: 'grant revoked or expired' };
    const effective = this.effective(parent);
    // A child of a root starts at the root's default mode; below that an
    // unnamed mode is the parent's effective one, followed live when asked.
    const inherit = spec.mode === undefined && spec.inherit === true && parent.parent !== undefined;
    const base = parent.parent === undefined ? meetMode(parent.mode, effective) : effective;
    const mode = spec.mode === undefined ? { ...base } : parseMode(spec.mode);
    if (!mode) return { ok: false, error: 'bad mode' };
    const ceiling = spec.ceiling === undefined ? { ...parent.ceiling } : parseCeiling(spec.ceiling);
    if (!ceiling) return { ok: false, error: 'bad ceiling' };
    if (!modeWithin(mode, ceiling)) return { ok: false, error: 'mode exceeds its own ceiling' };
    const child: Grant = {
      id: newGrantId(),
      parent: parent.id,
      holder: spec.holder,
      holderLabel: spec.holderLabel ?? spec.holder,
      taskId: spec.taskId,
      conversationId: spec.conversationId,
      workspaceId: parent.workspaceId,
      mode,
      ...(inherit ? { inherit: true } : {}),
      ceiling,
      types: spec.types ? [...spec.types] : [...parent.types],
      roots: spec.roots === undefined ? parent.roots : spec.roots,
      mayDerive: spec.mayDerive ?? Math.max(0, parent.mayDerive - 1),
      maySetMode: spec.maySetMode ?? parent.maySetMode,
      expiresAt: spec.expiresAt ?? parent.expiresAt,
      revoked: false,
      createdAt: this.now(),
    };
    const why = attenuationViolation(child, parent);
    if (why) return { ok: false, error: why };
    if (this.grants.size >= MAX_GRANTS) this.collect();
    if (this.grants.size >= MAX_GRANTS) return { ok: false, error: 'too many grants' };
    // A chat re-derived for the same conversation replaces its old grant.
    if (child.conversationId) {
      for (const old of this.all()) {
        if (old.conversationId === child.conversationId && old.parent === parent.id && !old.revoked) this.revokeTree(old.id);
      }
    }
    this.put(child);
    return { ok: true, value: child };
  }

  /**
   * Rule for changing modes (§5.1): the holder, with maySetMode, up to its
   * ceiling. A task grant (an agent's) may only be lowered.
   */
  setMode(id: string, caller: string, input: unknown): StoreResult<Grant> {
    const g = this.grants.get(id);
    if (!g) return { ok: false, error: 'no such grant' };
    if (g.holder !== caller) return { ok: false, error: 'grant not held by caller' };
    if (!this.live(g)) return { ok: false, error: 'grant revoked or expired' };
    const mode = parseMode(input);
    if (!mode) return { ok: false, error: 'bad mode' };
    if (g.taskId !== undefined) {
      if (!modeAtMost(mode, g.inherit ? this.effective(g) : g.mode)) return { ok: false, error: 'an agent may only lower its mode' };
    } else {
      if (!g.maySetMode) return { ok: false, error: 'this grant may not change its mode' };
      if (!modeWithin(mode, g.ceiling)) return { ok: false, error: 'mode exceeds the ceiling' };
      const parent = g.parent ? this.grants.get(g.parent) : undefined;
      if (parent?.parent !== undefined && parent.mode.readOnly && !mode.readOnly) return { ok: false, error: 'the parent is in plan mode' };
    }
    g.mode = mode;
    delete g.inherit;
    this.check();
    return { ok: true, value: g };
  }

  /** Whether `caller` holds `id` or any ancestor of it. */
  holdsChainOf(id: string, caller: string): boolean {
    const g = this.grants.get(id);
    return !!g && this.chain(g).some(x => x.holder === caller);
  }

  /** Revoke a grant and everything derived from it. Returns how many changed. */
  revokeTree(id: string): number {
    let n = 0;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const g = this.grants.get(cur);
      if (!g) continue;
      if (!g.revoked) { g.revoked = true; n++; }
      for (const c of this.grants.values()) if (c.parent === cur) stack.push(c.id);
    }
    return n;
  }

  /**
   * The grant to apply for a caller that named none (§6.2 step 2): the most
   * specific live grant bound to (caller, task), then the caller's own.
   */
  findFor(callerId: string, taskId?: string): Grant | undefined {
    const live = this.all().filter(g => g.holder === callerId && this.live(g));
    if (taskId) {
      const forTask = live.filter(g => g.taskId === taskId).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (forTask) return forTask;
    }
    return live.filter(g => g.taskId === undefined).sort((a, b) => this.chain(b).length - this.chain(a).length || b.createdAt - a.createdAt)[0];
  }

  /** A task grant presented without a match: task ids also bind any grant derived for the task. */
  forTask(taskId: string): Grant | undefined {
    return this.all().filter(g => g.taskId === taskId && this.live(g)).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  forConversation(conversationId: string): Grant | undefined {
    return this.all().find(g => g.conversationId === conversationId && this.live(g));
  }

  /** Re-bind a persisted chat grant to its respawned holder. */
  rebind(id: string, holder: string, label?: string): void {
    const g = this.grants.get(id);
    if (!g) return;
    g.holder = holder;
    if (label) g.holderLabel = label;
  }

  /** Drop task grants (§5.3: they end with the task and are never persisted). */
  dropTask(taskId: string): number {
    let n = 0;
    for (const g of this.all()) {
      if (g.taskId === taskId) { this.revokeTree(g.id); this.grants.delete(g.id); n++; }
    }
    return n;
  }

  /** Remove revoked and expired grants with no live descendants. */
  collect(): void {
    for (const g of this.all()) {
      if (this.live(g)) continue;
      const hasChild = this.all().some(c => c.parent === g.id && this.live(c));
      if (!hasChild) this.grants.delete(g.id);
    }
  }

  /** What is persisted: roots and chat grants, never task grants. */
  serialize(): Grant[] {
    return this.all().filter(g => g.taskId === undefined && !g.revoked);
  }

  load(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const g = raw as Grant;
      if (!g || typeof g.id !== 'string' || typeof g.holder !== 'string' || !g.mode || !g.ceiling) continue;
      const mode = parseMode(g.mode);
      const ceiling = parseCeiling(g.ceiling);
      if (!mode || !ceiling || !modeWithin(mode, ceiling)) continue;
      this.grants.set(g.id, { ...g, mode, ceiling, types: Array.isArray(g.types) ? g.types : [...DEFAULT_GRANT_TYPES], roots: g.roots ?? null, revoked: false });
    }
    // Drop any loaded child that no longer attenuates its parent (to fixed point for chains).
    let dropped = true;
    while (dropped) {
      dropped = false;
      for (const g of this.all()) {
        const p = g.parent ? this.grants.get(g.parent) : undefined;
        if (g.parent && (!p || !modeWithin(g.mode, p.ceiling) || !modeWithin(g.ceiling, p.ceiling) || g.workspaceId !== p.workspaceId)) {
          this.grants.delete(g.id);
          dropped = true;
        }
      }
    }
    this.check();
  }

  /** Rule 3 as an invariant: every child sits within its parent's ceiling. */
  check(): void {
    invariant(this.grants.size <= MAX_GRANTS, 'GrantStore: over its bound');
    for (const g of this.grants.values()) {
      invariant(modeWithin(g.mode, g.ceiling), `grant ${g.id}: mode above its own ceiling`);
      const p = g.parent ? this.grants.get(g.parent) : undefined;
      if (p && !g.revoked) {
        invariant(modeWithin(g.ceiling, p.ceiling), `grant ${g.id}: ceiling above its parent's`);
        invariant(g.workspaceId === p.workspaceId, `grant ${g.id}: crosses workspaces`);
      }
    }
  }

  private put(g: Grant): void {
    this.grants.set(g.id, g);
    this.check();
  }

  private clampDescendants(root: Grant): void {
    const stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      for (const c of this.grants.values()) {
        if (c.parent !== p.id) continue;
        if (!modeWithin(c.ceiling, p.ceiling)) {
          c.ceiling = { reach: minOf(c.ceiling.reach, p.ceiling.reach), beyond: minB(c.ceiling.beyond, p.ceiling.beyond) };
        }
        if (!modeWithin(c.mode, c.ceiling)) {
          c.mode = { ...c.mode, reach: minOf(c.mode.reach, c.ceiling.reach), beyond: minB(c.mode.beyond, c.ceiling.beyond) };
        }
        stack.push(c);
      }
    }
  }
}

function newGrantId(): string {
  return `g-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
