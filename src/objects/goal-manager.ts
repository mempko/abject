/**
 * GoalManager — shared, observable coordination surface for cross-agent progress tracking.
 *
 * When agents delegate work to other agents (Chat → ObjectCreator → inner agent),
 * progress events can't reach the UI because Abject mailboxes process messages
 * sequentially. GoalManager provides a shared Goal that any agent in a chain can
 * update. Subscribers (GoalBrowser, Chat) receive `changed` events for real-time UI.
 */

import { describeMessages, protocolText, protocolNumber, protocolObject } from '../core/protocol-description.js';
import { v4 as uuidv4 } from 'uuid';
import { withKeyedLock } from '../core/keyed-lock.js';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as precondition, requireNonEmpty } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
const log = new Log('GoalManager');

const GOAL_MANAGER_INTERFACE: InterfaceId = 'abjects:goal-manager';

// ─── Lifecycle TTLs ──────────────────────────────────────────────────

const COMPLETED_TTL_MS = 10 * 60 * 1000;   // 10 min completed → archived
const FAILED_TTL_MS    = 30 * 60 * 1000;   // 30 min failed → archived
const STALE_TTL_MS     = 15 * 60 * 1000;   // 15 min no progress → abandoned
const ARCHIVE_TTL_MS   = 60 * 60 * 1000;   // 1 hr archived → deleted
const MAX_ARCHIVED     = 200;

// ─── Data Model ──────────────────────────────────────────────────────

export type GoalId = string;

export interface ProgressEntry {
  timestamp: number;
  agentName: string;
  message: string;
  phase?: string;
  /**
   * Peer that authored this entry. Absent on entries written before
   * collaborative sync existed and on purely local goals. Each peer
   * republishes only its own entries, so this doubles as the merge key.
   */
  peerId?: string;
}

/**
 * Task state reported by another peer working the same goal.
 *
 * TupleSpace.put mints its own uuid and accepts no caller-supplied id, so a
 * remote task cannot be re-inserted into the local TupleSpace without taking
 * on a second identity (and being claimed a second time). Collaborator task
 * state therefore lives alongside the tuples rather than inside them,
 * addressed by the originating peer's taskId.
 */
export interface RemoteTaskProgress {
  taskId: string;
  goalId: GoalId;
  peerId: string;
  agentName?: string;
  status: string;
  message?: string;
  updatedAt: number;
}

/** A peer present on a shared goal. */
export interface GoalCollaborator {
  peerId: string;
  name?: string;
  lastSeenAt: number;
}

/** Envelope for a single scratchpad key published as its own LWW register. */
interface ScratchRegister {
  value: unknown;
  updatedAt: number;
  peerId: string;
}

export interface Goal {
  id: GoalId;
  parentId?: GoalId;
  /** Short, user-facing label for the goal (~200 chars). Used in lists / UI. */
  title: string;
  /**
   * Required. Free-form prose capturing the user's intent in detail. May
   * include explicit ordering ("do A then B then C"), examples, constraints,
   * and any other context. ScrumMaster's planning LLM reads this to decide
   * the sprint backlog. The user's actual phrasing should land here verbatim
   * where possible — title is the label, description is the substance.
   */
  description: string;
  /**
   * `paused` freezes the sprint: agents stop stepping, pending tasks are not
   * claimable, scrums don't fire, and the staleness watchdog ignores it.
   * Only the user (via Chat's pause control) moves a goal in and out of it.
   */
  status: 'active' | 'paused' | 'completed' | 'failed' | 'archived';
  createdBy: AbjectId;
  creatorName: string;
  /** Peer that created this goal. Stamped at createGoal; preserved across sync. Drives single-owner execution. */
  creatorPeerId?: string;
  progress: ProgressEntry[];
  childIds: GoalId[];
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  lastMeaningfulProgressAt?: number;
  scratchpad: Record<string, unknown>;
  /**
   * Messages the user sent while the goal was running (typed into the chat
   * during the sprint). ScrumMaster reads these at every decision point —
   * planning, review scrums, mid-round interjection checks — and marks them
   * `incorporated` once a committed decision has weighed them. They live
   * here rather than in the scratchpad so they are never mistaken for task
   * outputs by the synthesis prompt or the execution record.
   */
  interjections: Array<{ note: string; at: number; status: 'pending' | 'incorporated' }>;
  /**
   * Scrum-shaped orchestration: each ScrumMaster scrum that plans more work
   * increments this. New tasks created in that round carry the same scrumNumber
   * on their tuple, so the next scrum only fires when every task at the
   * current scrum number reaches terminal state. Starts at 0 (no scrum yet).
   */
  currentScrumNumber: number;
}

// ─── GoalManager ─────────────────────────────────────────────────────

export class GoalManager extends Abject {
  private goals: Map<GoalId, Goal> = new Map();
  private goalOrder: GoalId[] = [];
  private tupleSpaceId?: AbjectId;
  private sharedStateId?: AbjectId;
  private storageId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private localPeerId = '';
  /** Track taskIds for which we already emitted terminal events (idempotency guard). */
  private emittedTerminalTasks: Set<string> = new Set();
  /** Scrums for which `goalReadyForCompletion` has been emitted. Key is `${goalId}#${scrumNumber}` so each scrum
   *  gets one emission. Cleared per-key when a new task is added at that scrum number. */
  private readyForCompletionEmitted: Set<string> = new Set();

  /** GoalManager is spawned before the runtime; retry a missing dependency on use. */
  private async taskRuntime(): Promise<AbjectId | undefined> {
    this.agentAbjectId ??= await this.discoverDep('AgentAbject') ?? undefined;
    return this.agentAbjectId;
  }

  /**
   * Cancel every task of a goal: release + remove its tuples, abort running
   * agent tasks, clean the per-goal SharedState namespace. Shared by the
   * `cancelTasksForGoal` handler and `stopGoal` (handlers are serialized, so
   * stopGoal cannot self-request the other handler).
   */
  private async cancelTasksForGoalInternal(goalId: string): Promise<{ cancelled: number }> {
    if (!this.tupleSpaceId) return { cancelled: 0 };

    const ns = this.getTupleNamespace(goalId as GoalId);
    const tasks = await this.request<Array<{ id: string; fields: Record<string, unknown>; claimedBy?: string }>>(
      request(this.id, this.tupleSpaceId, 'scan', { pattern: { goalId }, namespace: ns })
    );

    let cancelled = 0;
    for (const task of tasks) {
      try {
        if (task.claimedBy) {
          try {
            await this.request(request(this.id, this.tupleSpaceId!, 'release', { tupleId: task.id, namespace: ns }));
          } catch { /* best effort */ }
        }
        await this.request(request(this.id, this.tupleSpaceId!, 'remove', { tupleId: task.id, namespace: ns }));
        this.emittedTerminalTasks.delete(task.id);
        cancelled++;
      } catch { /* best effort -- tuple may already be gone */ }
    }

    // Cancel running agent tasks for this goal
    const runtimeId = await this.taskRuntime();
    if (runtimeId) {
      try {
        await this.request(request(this.id, runtimeId, 'cancelTasksByGoal', { goalId }));
      } catch { /* best effort */ }
    }

    // Clean up per-goal SharedState namespace
    if (this.sharedStateId) {
      const stateNs = `goal-${goalId}`;
      try {
        await this.request(request(this.id, this.sharedStateId, 'delete', { name: stateNs, key: 'meta' }));
      } catch { /* best effort */ }
      try {
        await this.request(request(this.id, this.sharedStateId, 'unsubscribe', { name: stateNs }));
      } catch { /* best effort */ }
    }

    return { cancelled };
  }

  /** Walk up the parent chain to find the top-level goal ID, which is the TupleSpace namespace. */
  /**
   * Task progress reported by other peers, keyed `${goalId}::${taskId}`.
   * Deliberately never merged into the local TupleSpace — see RemoteTaskProgress.
   */
  private remoteTasks: Map<string, RemoteTaskProgress> = new Map();

  /** Peers seen on each shared goal: goalId -> peerId -> record. */
  private collaborators: Map<GoalId, Map<string, GoalCollaborator>> = new Map();

  /** LWW stamps for per-key scratchpad registers, keyed `${goalId}::${key}`. */
  private scratchStamps: Map<string, { updatedAt: number; peerId: string }> = new Map();

  /** This peer's id, falling back to the object id before Identity resolves. */
  private get selfPeerId(): string {
    return this.localPeerId || this.id;
  }

  /** SharedState namespace carrying a goal's meta blob and its registers. */
  /** Well-known SharedState namespace carrying the cross-peer goal catalog. */
  private readonly catalogNamespace = 'goals:catalog';

  /** LWW stamps for catalog registers, keyed by goalId. */
  private catalogStamps = new Map<string, { updatedAt: number; peerId: string }>();

  /** Goals adopted from a peer's catalog rather than created here. */
  private remoteGoalIds = new Set<string>();

  private goalNamespace(goalId: GoalId): string {
    return `goal-${goalId}`;
  }

  /**
   * Decide whether an incoming stamped write beats what we hold. Peer clocks
   * are not synchronised, so an equal timestamp is broken deterministically on
   * peerId: every replica then picks the same winner and they stop oscillating.
   */
  private registerWins(
    incoming: { updatedAt: number; peerId: string },
    current?: { updatedAt: number; peerId: string },
  ): boolean {
    if (!current) return true;
    if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt;
    return incoming.peerId > current.peerId;
  }

  /** Fire-and-forget write of one collaborative register. */
  private setRegister(goalId: GoalId, key: string, value: unknown): void {
    if (!this.sharedStateId) return;
    this.request(
      request(this.id, this.sharedStateId, 'set', {
        name: this.goalNamespace(goalId),
        key,
        value,
        persist: true,
      })
    ).catch(err => {
      log.warn(`register set failed (${key}): ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Publish one scratchpad key as its own LWW register. */
  private syncScratchKeyToSharedState(goal: Goal, key: string, value: unknown): void {
    const stamp = { updatedAt: Date.now(), peerId: this.selfPeerId };
    this.scratchStamps.set(`${goal.id}::${key}`, stamp);
    const reg: ScratchRegister = { value, updatedAt: stamp.updatedAt, peerId: stamp.peerId };
    this.setRegister(goal.id, `scratch:${key}`, reg);
  }

  /**
   * Publish this peer's progress entries. Each peer owns `progress:<peerId>`;
   * a single shared array would make every collaborator's heartbeat overwrite
   * everyone else's.
   */
  private syncProgressToSharedState(goal: Goal): void {
    const peerId = this.selfPeerId;
    const mine = goal.progress.filter(p => (p.peerId ?? peerId) === peerId);
    const tail = mine.length > 100 ? mine.slice(mine.length - 100) : mine;
    this.setRegister(goal.id, `progress:${peerId}`, { peerId, entries: tail, updatedAt: Date.now() });
  }

  /**
   * Replace everything we hold from one peer with that peer's current log.
   * Idempotent by construction: replaying a register yields the same array,
   * which is what makes reconnect-and-resync safe to run repeatedly.
   */
  private mergeRemoteProgress(goal: Goal, remotePeerId: string, entries: ProgressEntry[]): void {
    if (remotePeerId === this.selfPeerId) return;
    const kept = goal.progress.filter(p => p.peerId !== remotePeerId);
    for (const e of entries) {
      if (!e || typeof e.timestamp !== 'number') continue;
      kept.push({ ...e, peerId: remotePeerId });
    }
    kept.sort((a, b) => a.timestamp - b.timestamp);
    goal.progress = kept.length > 200 ? kept.slice(kept.length - 200) : kept;
  }

  /**
   * Fold a remote `meta` blob's scratchpad in without overwriting. Any key we
   * hold a register stamp for is owned by that register, and a stale meta write
   * must not undo a newer per-key write from another collaborator. This only
   * ever fills gaps — it covers keys written before per-key registers existed.
   */
  private mergeRemoteScratchpad(goal: Goal, remote: Record<string, unknown> | undefined): void {
    if (!remote) return;
    for (const [key, value] of Object.entries(remote)) {
      if (this.scratchStamps.has(`${goal.id}::${key}`)) continue;
      if (!(key in goal.scratchpad)) goal.scratchpad[key] = value;
    }
  }

  private remoteTaskKey(goalId: GoalId, taskId: string): string {
    return `${goalId}::${taskId}`;
  }

  /** Apply one collaborative register received from SharedState. */
  private applyRemoteRegister(goalId: GoalId, key: string, value: unknown): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    if (key.startsWith('scratch:')) {
      const name = key.slice('scratch:'.length);
      const reg = value as ScratchRegister | undefined;
      if (!reg || typeof reg !== 'object' || typeof reg.updatedAt !== 'number') return;
      const stampKey = `${goalId}::${name}`;
      if (!this.registerWins(reg, this.scratchStamps.get(stampKey))) return;
      this.scratchStamps.set(stampKey, { updatedAt: reg.updatedAt, peerId: reg.peerId });
      goal.scratchpad[name] = reg.value;
      goal.updatedAt = Date.now();
      this.changed('goalUpdated', { goalId, message: `scratchpad.${name} updated by ${String(reg.peerId).slice(0, 8)}` });
      return;
    }

    if (key.startsWith('progress:')) {
      const reg = value as { peerId?: string; entries?: ProgressEntry[] } | undefined;
      if (!reg || !Array.isArray(reg.entries)) return;
      this.mergeRemoteProgress(goal, reg.peerId ?? key.slice('progress:'.length), reg.entries);
      this.changed('goalUpdated', { goalId, message: 'Collaborator progress', progress: goal.progress });
      return;
    }

    if (key.startsWith('task:')) {
      const rec = value as RemoteTaskProgress | undefined;
      if (!rec || typeof rec.updatedAt !== 'number') return;
      const taskId = rec.taskId ?? key.slice('task:'.length);
      const mapKey = this.remoteTaskKey(goalId, taskId);
      if (!this.registerWins(rec, this.remoteTasks.get(mapKey))) return;
      const merged: RemoteTaskProgress = { ...rec, taskId, goalId };
      this.remoteTasks.set(mapKey, merged);
      this.changed('taskProgress', merged);
      return;
    }

    if (key.startsWith('collaborator:')) {
      const rec = value as GoalCollaborator | undefined;
      if (!rec || typeof rec.lastSeenAt !== 'number') return;
      let roster = this.collaborators.get(goalId);
      if (!roster) { roster = new Map(); this.collaborators.set(goalId, roster); }
      const existing = roster.get(rec.peerId);
      if (existing && existing.lastSeenAt >= rec.lastSeenAt) return;
      roster.set(rec.peerId, rec);
      this.changed('collaboratorsChanged', { goalId, collaborators: Array.from(roster.values()) });
    }
  }

  /**
   * Apply every register in a namespace snapshot. This is the reconnect path:
   * a peer that was offline missed the individual `stateChanged` events, so on
   * join it reads the namespace whole and replays it.
   */
  private applyRemoteRegisters(goalId: GoalId, snapshot: Record<string, unknown> | undefined): void {
    if (!snapshot) return;
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === 'meta') continue;
      this.applyRemoteRegister(goalId, key, value);
    }
  }

  /** Announce this peer on a goal so collaborators can list who is present. */
  private announceCollaborator(goalId: GoalId): void {
    const record: GoalCollaborator = { peerId: this.selfPeerId, lastSeenAt: Date.now() };
    let roster = this.collaborators.get(goalId);
    if (!roster) { roster = new Map(); this.collaborators.set(goalId, roster); }
    roster.set(record.peerId, record);
    this.setRegister(goalId, `collaborator:${record.peerId}`, record);
  }

  /**
   * Create and subscribe the shared goal catalog, publish every local goal
   * into it, and adopt whatever peers have already published.
   *
   * The catalog is the discovery bridge. A peer cannot subscribe to a
   * `goal-<id>` namespace it has never heard of, and SharedState drops sync
   * requests for namespaces it does not itself hold, so goals stayed invisible
   * across peers until one well-known namespace advertised them.
   */
  private async initGoalCatalog(): Promise<void> {
    if (!this.sharedStateId) return;
    try {
      await this.request(request(this.id, this.sharedStateId, 'create', { name: this.catalogNamespace }));
      await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: this.catalogNamespace }));

      for (const goal of this.goals.values()) {
        this.publishCatalogEntry(goal);
      }

      const all = await this.request<Record<string, unknown>>(
        request(this.id, this.sharedStateId, 'getAll', { name: this.catalogNamespace })
      );
      if (all) {
        for (const [key, value] of Object.entries(all)) {
          await this.handleCatalogEntry(key, value);
        }
      }
    } catch { /* best effort */ }
  }

  /** Advertise one goal in the shared catalog so peers can discover it. */
  private publishCatalogEntry(goal: Goal): void {
    if (!this.sharedStateId) return;
    // Never re-advertise a goal we merely mirror: its owner is the publisher.
    if (this.remoteGoalIds.has(goal.id)) return;
    const record = {
      goalId: goal.id,
      title: goal.title,
      status: goal.status,
      ownerPeerId: goal.creatorPeerId || this.selfPeerId,
      deleted: false,
      updatedAt: Date.now(),
      peerId: this.selfPeerId,
    };
    this.catalogStamps.set(goal.id, { updatedAt: record.updatedAt, peerId: record.peerId });
    void this.request(request(this.id, this.sharedStateId, 'set', {
      name: this.catalogNamespace,
      key: `catalog:${goal.id}`,
      value: record,
      persist: true,
    })).catch(() => { /* best effort */ });
  }

  /** Mark a goal gone in the catalog so peers stop resurrecting it on boot. */
  private publishCatalogTombstone(goalId: GoalId): void {
    if (!this.sharedStateId) return;
    const stamp = { updatedAt: Date.now(), peerId: this.selfPeerId };
    this.catalogStamps.set(goalId, stamp);
    this.remoteGoalIds.delete(goalId);
    void this.request(request(this.id, this.sharedStateId, 'set', {
      name: this.catalogNamespace,
      key: `catalog:${goalId}`,
      value: { goalId, deleted: true, updatedAt: stamp.updatedAt, peerId: stamp.peerId },
      persist: true,
    })).catch(() => { /* best effort */ });
  }

  /** Merge one catalog register, auto-subscribing any newly seen remote goal. */
  private async handleCatalogEntry(key: string | undefined, value: unknown): Promise<void> {
    if (!key || !key.startsWith('catalog:')) return;
    const record = value as {
      goalId?: string; title?: string; ownerPeerId?: string;
      deleted?: boolean; updatedAt?: number; peerId?: string;
    } | undefined;
    if (!record || typeof record.goalId !== 'string') return;

    const goalId = record.goalId as GoalId;
    const stamp = {
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      peerId: typeof record.peerId === 'string' ? record.peerId : '',
    };
    if (!this.registerWins(stamp, this.catalogStamps.get(goalId))) return;
    this.catalogStamps.set(goalId, stamp);

    if (record.deleted === true) {
      this.remoteGoalIds.delete(goalId);
      return;
    }

    const owner = record.ownerPeerId ?? stamp.peerId;
    if (owner === this.selfPeerId) return;
    if (this.goals.has(goalId)) return;

    this.remoteGoalIds.add(goalId);
    await this.joinRemoteGoal(goalId);
  }

  /**
   * Subscribe a peer's `goal-<id>` namespace and adopt the goal locally.
   * Kept separate from the `subscribeGoal` handler so the catalog watcher does
   * not have to fabricate a request message to reuse it.
   */
  private async joinRemoteGoal(goalId: GoalId): Promise<void> {
    if (!this.sharedStateId) return;
    const ns = this.goalNamespace(goalId);
    try {
      await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
      await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));

      const all = await this.request<Record<string, unknown>>(
        request(this.id, this.sharedStateId, 'getAll', { name: ns })
      );
      const meta = all?.meta;
      if (meta && typeof meta === 'object' && 'id' in (meta as object)) {
        // `meta` never carries `progress` (see syncGoalToSharedState), so fill
        // the collection fields before anything dereferences them.
        const remote = meta as Goal;
        const goalData: Goal = { ...remote, progress: remote.progress ?? [], scratchpad: remote.scratchpad ?? {} };
        if (!this.goals.has(goalData.id)) {
          this.goals.set(goalData.id, goalData);
          if (!this.goalOrder.includes(goalData.id)) this.goalOrder.push(goalData.id);
          this.saveGoalIndex();
          this.changed('goalCreated', {
            goalId: goalData.id,
            title: goalData.title,
            description: goalData.description,
            parentId: goalData.parentId,
          });
        }
        this.applyRemoteRegisters(goalData.id, all);
      }
      this.announceCollaborator(goalId);
      log.info(`Joined remote goal ${goalId} discovered via ${this.catalogNamespace}`);
    } catch { /* best effort */ }
  }

  private getTupleNamespace(goalId: GoalId): string {
    let current = this.goals.get(goalId);
    while (current?.parentId) {
      const parent = this.goals.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current?.id ?? goalId;
  }

  constructor() {
    super({
      manifest: {
        name: 'GoalManager',
        description:
          'Shared coordination surface for cross-agent progress tracking. Any agent in a delegation chain can update goals, and subscribers receive real-time changed events.',
        version: '1.0.0',
        interface: {
          id: GOAL_MANAGER_INTERFACE,
          name: 'GoalManager',
          description: 'Goal tracking and progress coordination',
          methods: [
            {
              name: 'createGoal',
              description: 'Create a new goal for tracking progress',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Short user-facing label (~200 chars)' },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'REQUIRED. Free-form prose capturing the user\'s intent in detail — including explicit ordering ("do A then B then C"), constraints, examples, and what counts as success. ScrumMaster reads this at every scrum.' },
                { name: 'parentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Parent goal ID for sub-goals', optional: true },
              ],
              returns: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'updateProgress',
              description: 'Append a progress entry to a goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Progress message' },
                { name: 'phase', type: { kind: 'primitive', primitive: 'string' }, description: 'Current phase', optional: true },
                { name: 'agentName', type: { kind: 'primitive', primitive: 'string' }, description: 'Agent reporting progress', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'completeGoal',
              description: 'Mark a goal as completed',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'result', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional result data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'startNextScrum',
              description: 'Increment the goal\'s currentScrumNumber. Called by ScrumMaster after a scrum plans more tasks so they land at the new scrum number.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'operationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Replay identity for this round', optional: true },
                { name: 'preserveTaskIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Earlier tasks retained in the new backlog', optional: true },
              ],
              returns: { kind: 'object', properties: { scrumNumber: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'failGoal',
              description: 'Mark a goal as failed',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'error', type: { kind: 'primitive', primitive: 'string' }, description: 'Error message', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'pauseGoal',
              description: 'Freeze an active goal: agents stop stepping, pending tasks stop being claimable, scrums stop firing. The user can interject via appendGoalNote, then resumeGoal. Emits goalPaused.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'resumeGoal',
              description: 'Resume a paused goal: agents continue stepping and the scrum cycle re-arms. Emits goalResumed.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'stopGoal',
              description: 'Hard-stop a goal (active or paused): cancels every task including running agent loops, then fails the goal as "Stopped by user". Emits goalFailed.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'appendGoalNote',
              description: 'Queue a user interjection on a running or paused goal. ScrumMaster weighs pending interjections at every decision point (planning, review scrums, mid-round checks) and may re-plan, continue, stop, or ask for clarification. Emits goalInterjection.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'note', type: { kind: 'primitive', primitive: 'string' }, description: 'The note text' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'reportGoalProgress',
              description: 'Broadcast a human-readable progress line for a goal (emits goalUpdated) without changing goal state.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'The progress line to show the user' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'requestClarification',
              description: 'Pause the goal and ask the user a question (emits goalClarificationRequested to goal subscribers). The user\'s next message queues as an interjection and resumes the goal.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'question', type: { kind: 'primitive', primitive: 'string' }, description: 'The question to put to the user' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'markInterjectionsIncorporated',
              description: 'Flip pending interjections (with timestamp <= upTo) to incorporated. Called when a scrum commits a decision that weighed them. Returns the count flipped.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'upTo', type: { kind: 'primitive', primitive: 'number' }, description: 'Latest interjection timestamp the committed decision saw' },
              ],
              returns: { kind: 'primitive', primitive: 'number' },
            },
            {
              name: 'cancelOutstandingTasks',
              description: 'Cancel every non-terminal task of a goal without failing it — clears the way for an immediate re-plan. Completed and failed task records survive.',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'object', properties: {
                cancelled: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'getGoal',
              description: 'Get a goal by ID',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'reference', reference: 'Goal' },
            },
            {
              name: 'listGoals',
              description: 'List goals, optionally filtered by status or parent',
              parameters: [
                { name: 'status', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by status', optional: true },
                { name: 'parentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by parent goal ID', optional: true },
                { name: 'includeArchived', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Include archived goals', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'Goal' } },
            },
            {
              name: 'clearCompleted',
              description: 'Archive all completed and failed goals (they are deleted after 1 hour)',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'getStats',
              description: 'Get goal counts by status',
              parameters: [],
              returns: { kind: 'object', properties: {
                active: { kind: 'primitive', primitive: 'number' },
                completed: { kind: 'primitive', primitive: 'number' },
                failed: { kind: 'primitive', primitive: 'number' },
                archived: { kind: 'primitive', primitive: 'number' },
                total: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'addTask',
              description: 'Add a task to the TupleSpace for a goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                { name: 'data', type: { kind: 'object', properties: {} }, description: 'Task-specific payload', optional: true },
                { name: 'dependsOn', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Task IDs that must complete before this task can start', optional: true },
                { name: 'produces', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'Scratchpad keys this task is expected to write. Each entry is { key: string, description: string } describing the value shape for downstream consumers.', optional: true },
                { name: 'consumes', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Scratchpad keys this task expects to read. The agent claiming this task will see the full values for these keys in its system prompt.', optional: true },
              ],
              returns: { kind: 'object', properties: { taskId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'claimTask',
              description: 'Claim a pending task from the TupleSpace',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by goal ID', optional: true },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by task type', optional: true },
              ],
              returns: { kind: 'reference', reference: 'TupleEntry' },
            },
            {
              name: 'completeTask',
              description: 'Mark a task as done',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task tuple ID' },
                { name: 'result', type: { kind: 'primitive', primitive: 'string' }, description: 'Result data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'failTask',
              description: 'Mark a task as failed',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task tuple ID' },
                { name: 'error', type: { kind: 'primitive', primitive: 'string' }, description: 'Error message', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getTasksForGoal',
              description: 'Get all tasks for a goal, optionally filtered by status',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'status', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by status', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'TupleEntry' } },
            },
            {
              name: 'updateTaskAttempts',
              description: 'Increment the attempts counter on a task tuple',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task tuple ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getResultsForGoal',
              description: 'Get completed tasks with results for a goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'TupleEntry' } },
            },
            {
              name: 'subscribeGoal',
              description: 'Subscribe to a remote goal by ID — creates + subscribes to its SharedState namespace and adds it to the local index',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal UUID to subscribe to' },
              ],
              returns: { kind: 'reference', reference: 'Goal' },
            },
            {
              name: 'cancelTasksForGoal',
              description: 'Cancel all tasks for a goal — releases claims, removes tuples from TupleSpace',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'object', properties: { cancelled: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'cancelPendingTasks',
              description: 'Cancel all pending tasks for a goal (used during replan)',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'object', properties: { cancelled: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'writeGoalData',
              description: 'Write a key-value pair to a goal\'s scratchpad for sharing data between agents',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Scratchpad key' },
                { name: 'value', type: { kind: 'primitive', primitive: 'string' }, description: 'Value to store (any JSON-serializable value)' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'readGoalData',
              description: 'Read a key or the entire scratchpad from a goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Scratchpad key (omit to read entire scratchpad)', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'string' },
            },
            {
              name: 'updateTaskProgress',
              description: 'Publish local status for one task so collaborators on a shared goal see it',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID as minted by the originating peer' },
                { name: 'status', type: { kind: 'primitive', primitive: 'string' }, description: 'Task status (pending, in_progress, done, failed)' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable detail', optional: true },
                { name: 'agentName', type: { kind: 'primitive', primitive: 'string' }, description: 'Agent working the task', optional: true },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'getCollaboratorTasks',
              description: 'Task progress reported by other peers on a shared goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                goalId: { kind: 'primitive', primitive: 'string' },
                peerId: { kind: 'primitive', primitive: 'string' },
                status: { kind: 'primitive', primitive: 'string' },
                updatedAt: { kind: 'primitive', primitive: 'number' },
              } } },
            },
            {
              name: 'getCollaborators',
              description: 'Peers currently present on a shared goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                peerId: { kind: 'primitive', primitive: 'string' },
                lastSeenAt: { kind: 'primitive', primitive: 'number' },
              } } },
            },
            {
              name: 'reconcileGoal',
              description: 'Re-read the whole collaborative namespace of a shared goal and replay it locally, for use after a reconnect',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'object', properties: { reconciled: { kind: 'primitive', primitive: 'number' } } },
            },
          ],
          events: [
            { name: 'goalCreated', description: 'A new goal was created', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'taskProgress', description: 'A peer reported task status on a shared goal', payload: { kind: 'reference', reference: 'RemoteTaskProgress' } },
            { name: 'collaboratorsChanged', description: 'The set of peers present on a shared goal changed', payload: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'goalUpdated', description: 'A goal received a progress update', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalCompleted', description: 'A goal was completed', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalFailed', description: 'A goal failed', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalPaused', description: 'A goal was paused by the user', payload: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'goalResumed', description: 'A paused goal was resumed', payload: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'goalInterjection', description: 'The user sent a message while the goal was running. ScrumMaster weighs it against the plan and in-flight work — possibly re-planning, continuing, stopping, or asking for clarification.', payload: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' }, note: { kind: 'primitive', primitive: 'string' }, at: { kind: 'primitive', primitive: 'number' } } } },
            { name: 'goalClarificationRequested', description: 'ScrumMaster paused the goal to ask the user a question. The next user message answers it and resumes the goal.', payload: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' }, question: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'goalsCleared', description: 'Completed/failed goals were cleared', payload: { kind: 'primitive', primitive: 'undefined' } },
            { name: 'goalsSwept', description: 'Goals were archived or deleted by lifecycle sweep', payload: { kind: 'primitive', primitive: 'undefined' } },
            { name: 'taskCompleted', description: 'A task was completed', payload: { kind: 'object', properties: { taskId: { kind: 'primitive', primitive: 'string' }, goalId: { kind: 'primitive', primitive: 'string' }, result: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'taskPermanentlyFailed', description: 'A task failed. The next scrum may schedule a corrective task or accept the failure.', payload: { kind: 'object', properties: { taskId: { kind: 'primitive', primitive: 'string' }, goalId: { kind: 'primitive', primitive: 'string' }, error: { kind: 'primitive', primitive: 'string' }, attempts: { kind: 'primitive', primitive: 'number' } } } },
            { name: 'goalReadyForCompletion', description: 'All tasks of a goal reached terminal state. Sent once to the goal\'s creator so they can decide whether to completeGoal, replan, failGoal, or add follow-up tasks. Goal stays active until the creator acts on it.', payload: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' }, creatorAgentId: { kind: 'primitive', primitive: 'string' }, doneTaskIds: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, failedTaskIds: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } } } } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.tupleSpaceId = await this.discoverDep('TupleSpace') ?? undefined;
    this.sharedStateId = await this.discoverDep('SharedState') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.agentAbjectId = await this.discoverDep('AgentAbject') ?? undefined;

    // Subscribe to TupleSpace events so we detect remote permanently_failed/done transitions
    if (this.tupleSpaceId) {
      try {
        await this.request(request(this.id, this.tupleSpaceId, 'addDependent', {}));
      } catch { /* TupleSpace may not be ready yet */ }
    }

    // Get local peerId from Identity
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.localPeerId = identity.peerId;
      } catch { /* Identity may not be ready */ }
    }

    // Load goal index from local Storage and subscribe to each goal's SharedState
    await this.loadGoalIndex();
    await this.initGoalCatalog();
  }

  /** Load the local goal index from Storage and subscribe to each goal's per-goal SharedState. */
  private async loadGoalIndex(): Promise<void> {
    if (!this.storageId) return;

    let goalIds: string[] = [];
    try {
      const stored = await this.request<string[] | null>(
        request(this.id, this.storageId, 'get', { key: 'goals:index' })
      );
      if (Array.isArray(stored)) goalIds = stored;
    } catch { /* No index yet */ }

    if (goalIds.length === 0) return;

    // Subscribe to each goal's SharedState and load metadata
    for (const goalId of goalIds) {
      const ns = `goal-${goalId}`;
      try {
        if (this.sharedStateId) {
          await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
          await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));

          const all = await this.request<Record<string, unknown>>(
            request(this.id, this.sharedStateId, 'getAll', { name: ns })
          );
          const meta = all?.meta;
          if (meta && typeof meta === 'object' && 'id' in (meta as object)) {
            const goalData = meta as Goal;
            const goal: Goal = {
              ...goalData,
              progress: goalData.progress ?? [],
              scratchpad: goalData.scratchpad ?? {},
              currentScrumNumber: goalData.currentScrumNumber ?? 0,
              interjections: goalData.interjections ?? [],
              // Legacy goals from before description was required: backfill
              // from title so the field invariant holds.
              description: goalData.description ?? goalData.title,
            };
            if (this.storageId) {
              const local = await this.request<Record<string, unknown> | null>(request(this.id, this.storageId, 'get', { key: `goals:learning:${goal.id}` })).catch(() => null);
              if (local?.version === 2) {
                const state = local.goalState as Partial<Goal> | undefined;
                // Legacy checkpoints have no ordering information. They must
                // not undo a newer pause, stop or completion from SharedState.
                const useLocal = typeof state?.updatedAt === 'number' && state.updatedAt >= goal.updatedAt;
                if (useLocal) Object.assign(goal, state);
                const scratchpad = (local.scratchpad ?? {}) as Record<string, unknown>;
                goal.scratchpad = useLocal
                  ? { ...goal.scratchpad, ...scratchpad }
                  : { ...scratchpad, ...goal.scratchpad };
                goal.lastMeaningfulProgressAt = Math.max(goal.lastMeaningfulProgressAt ?? 0, state?.lastMeaningfulProgressAt ?? 0) || undefined;
              }
              else if (local) goal.scratchpad = { ...goal.scratchpad, ...local };
            }
            this.goals.set(goal.id, goal);
            if (!this.goalOrder.includes(goal.id)) {
              this.goalOrder.push(goal.id);
            }
          }
        }
      } catch { /* Goal may have been deleted by another peer */ }
    }

    if (this.goals.size > 0) {
      log.info(`Loaded ${this.goals.size} persisted goals from index`);
    }
  }

  /** Persist the local goal index to Storage. */
  private async saveGoalIndex(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: 'goals:index',
        value: this.goalOrder,
      }));
    } catch { /* best effort */ }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GoalManager Usage Guide

### Create a Goal

  const { goalId } = await call(await dep('GoalManager'), 'createGoal', {
    title: 'Build a counter widget',
    parentId: 'optional-parent-goal-id',  // for sub-goals
  });

### Update Progress

  await call(await dep('GoalManager'), 'updateProgress', {
    goalId,
    message: 'Generating handler code...',
    phase: 'codegen',
    agentName: 'ObjectCreator',
  });

### Complete or Fail a Goal

  await call(await dep('GoalManager'), 'completeGoal', { goalId, result: 'Created successfully' });
  await call(await dep('GoalManager'), 'failGoal', { goalId, error: 'Compilation failed' });

### Query Goals

  const goal = await call(await dep('GoalManager'), 'getGoal', { goalId });
  // goal: { id, title, status, progress: [...], childIds, parentId?, result?, error? }

  const goals = await call(await dep('GoalManager'), 'listGoals', { status: 'active' });
  // Filter by status ('active'|'completed'|'failed'|'archived') and/or parentId
  // Archived goals are excluded by default:
  const allGoals = await call(await dep('GoalManager'), 'listGoals', { includeArchived: true });

### Goal Stats

  const stats = await call(await dep('GoalManager'), 'getStats', {});
  // { active, completed, failed, archived, total }

### Goal Lifecycle
Goals have automatic lifecycle management:
- Active goals with no progress for 15 min are marked as failed (abandoned).
- Completed goals are archived after 10 min, failed goals after 30 min.
- Archived goals are permanently deleted after 1 hour.
- clearCompleted archives completed/failed goals (not immediate delete).
- Sweeps happen lazily on createGoal, getGoal, and listGoals — no timers.

### Subscribe to Goal Events

  await call(await dep('GoalManager'), 'addDependent', {});
  // Receive changed events: goalCreated, goalUpdated, goalCompleted, goalFailed, goalsSwept

### Task Convenience Methods (TupleSpace integration)

  // Add a task to the TupleSpace for a goal
  const { taskId } = await call(await dep('GoalManager'), 'addTask', {
    goalId, description: 'Build a counter widget', data: { extra: 'info' },
  });

  // Claim a pending task (returns null if none available)
  const claimed = await call(await dep('GoalManager'), 'claimTask', { goalId });
  if (claimed) {
    const task = claimed.tuple;  // TupleEntry with .id, .fields
    // ... do work ...
    await call(await dep('GoalManager'), 'completeTask', { taskId: task.id, result: 'Done!' });
  }

  // Fail a task (releases claim so others can retry)
  await call(await dep('GoalManager'), 'failTask', { taskId, error: 'Something went wrong' });

  // Get all tasks for a goal
  const tasks = await call(await dep('GoalManager'), 'getTasksForGoal', { goalId, status: 'pending' });

  // Get completed tasks with results
  const results = await call(await dep('GoalManager'), 'getResultsForGoal', { goalId });

Tasks are planned and routed by the workspace's planner (ScrumMaster): when a
top-level goal is created it runs a scrum meeting, polls agents via the ask
protocol to learn what each can contribute right now, stages tasks with an
assigned agent, and dispatches them through AgentAbject's per-agent queues.
When every task in the current round reaches a terminal state, the planner
reviews results and either plans another round or completes/fails the goal.

### Goal Scratchpad (shared key-value store)

  // Write data to the goal's scratchpad (persists + syncs across peers)
  await call(await dep('GoalManager'), 'writeGoalData', { goalId, key: 'spec', value: { ... } });

  // Read a single key
  const spec = await call(await dep('GoalManager'), 'readGoalData', { goalId, key: 'spec' });

  // Read entire scratchpad
  const all = await call(await dep('GoalManager'), 'readGoalData', { goalId });

### IMPORTANT
- The interface ID is 'abjects:goal-manager'.
- Goals are created by their originator (e.g. Chat creates one per user request); the planner owns the goal's lifecycle while a scrum is running it.
- Sub-goals: pass parentId when creating a goal to link it under a parent.
- clearCompleted archives (not deletes) completed/failed goals. Archived goals auto-delete after 1 hour.
- listGoals excludes archived goals by default. Pass includeArchived: true to see them.
- Tasks are backed by TupleSpace (CRDT-synced) — they persist across restarts and sync across peers.
- Goals metadata syncs to SharedState for cross-peer visibility.
- Tasks carry the agent the planner assigned them to after polling abilities; there is no task-type matching.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);

    // Include current goal status summary
    const active = [...this.goals.values()].filter(g => g.status === 'active');
    const completed = [...this.goals.values()].filter(g => g.status === 'completed');
    const failed = [...this.goals.values()].filter(g => g.status === 'failed');
    prompt += `\n\n### Current State\n`;
    prompt += `${active.length} active, ${completed.length} completed, ${failed.length} failed goals.\n`;
    if (active.length > 0) {
      prompt += '\nActive goals:\n';
      for (const g of active.slice(0, 5)) {
        prompt += `- ${g.title}\n`;
      }
    }

    return this.askLlm(prompt, question, 'balanced');
  }

  private budgetOwner(goalId: string): Goal {
    let goal = this.goals.get(goalId);
    if (!goal) throw new Error('Unknown goal');
    const visited = new Set<string>();
    while (goal.parentId) {
      if (visited.has(goal.id)) throw new Error('Cyclic goal ancestry');
      visited.add(goal.id);
      const parent = this.goals.get(goal.parentId);
      if (!parent) throw new Error('Parent goal unavailable');
      goal = parent;
    }
    return goal;
  }

  private async sweepGoals(): Promise<void> {
    const now = Date.now();
    let changed = false;

    for (const [id, goal] of this.goals) {
      if (goal.scratchpad['learning/review'] === 'pending') continue;
      switch (goal.status) {
        case 'active':
          // GoalObserver owns liveness decisions; a read must not abandon running work.
          break;
        case 'completed':
          if (now - goal.updatedAt >= COMPLETED_TTL_MS) {
            goal.status = 'archived';
            goal.updatedAt = now;
            changed = true;
            if (this.tupleSpaceId && !goal.parentId) {
              try {
                await this.request(request(this.id, this.tupleSpaceId, 'removeNamespace', { namespace: goal.id }));
              } catch { /* best effort */ }
            }
          }
          break;
        case 'failed':
          if (now - goal.updatedAt >= FAILED_TTL_MS) {
            goal.status = 'archived';
            goal.updatedAt = now;
            changed = true;
            if (this.tupleSpaceId && !goal.parentId) {
              try {
                await this.request(request(this.id, this.tupleSpaceId, 'removeNamespace', { namespace: goal.id }));
              } catch { /* best effort */ }
            }
          }
          break;
        case 'archived':
          if (now - goal.updatedAt >= ARCHIVE_TTL_MS) {
            // Clean up SharedState namespace to prevent sync floods
            if (this.sharedStateId) {
              this.publishCatalogTombstone(id as GoalId);
              try {
                await this.request(request(this.id, this.sharedStateId, 'removeNamespace', { name: `goal-${id}` }));
              } catch { /* best effort */ }
            }
            this.goals.delete(id);
            const idx = this.goalOrder.indexOf(id);
            if (idx !== -1) this.goalOrder.splice(idx, 1);
            changed = true;
          }
          break;
      }
    }

    // Enforce MAX_ARCHIVED cap — evict oldest first
    const archived = this.goalOrder
      .map(id => this.goals.get(id))
      .filter((g): g is Goal => g !== undefined && g.status === 'archived' && g.scratchpad['learning/review'] !== 'pending');

    if (archived.length > MAX_ARCHIVED) {
      const toEvict = archived
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, archived.length - MAX_ARCHIVED);

      for (const goal of toEvict) {
        if (this.sharedStateId) {
          this.publishCatalogTombstone(goal.id);
          try {
            await this.request(request(this.id, this.sharedStateId, 'removeNamespace', { name: `goal-${goal.id}` }));
          } catch { /* best effort */ }
        }
        this.goals.delete(goal.id);
        const idx = this.goalOrder.indexOf(goal.id);
        if (idx !== -1) this.goalOrder.splice(idx, 1);
        changed = true;
      }
    }

    if (changed) {
      this.changed('goalsSwept', {});
    }
  }

  /**
   * After a task transition, check whether every task at the goal's
   * currentScrumNumber has reached terminal state. If so, fire
   * `goalReadyForCompletion` so ScrumMaster can run the next scrum, which
   * decides whether to declare the sprint done or plan more tasks. The goal
   * stays `active` until ScrumMaster acts.
   *
     * Scoped by scrum number and explicitly retained task IDs: preserved work
     * keeps its original round for attribution, but still gates this review.
   *
   * Idempotent per (goalId, scrumNumber): each scrum gets one emission.
   * `addTask` clears the matching key so the next scrum gets its own.
   */
  private async maybeEmitGoalReadyForCompletion(goalId: GoalId): Promise<void> {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== 'active') return;
    const scrumKey = `${goalId}#${goal.currentScrumNumber}`;
    if (this.readyForCompletionEmitted.has(scrumKey)) return;
    if (!this.tupleSpaceId) return;
    let tasks: Array<{ id: string; fields: Record<string, unknown> }>;
    try {
      tasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
        request(this.id, this.tupleSpaceId, 'scan', {
          namespace: this.getTupleNamespace(goalId),
          pattern: { goalId },
        }),
      );
    } catch {
      return;
    }
    if (tasks.length === 0) return;
    // The receiver owns backlog membership, including retained earlier work.
    const retained = new Set((goal.scratchpad[`learning/backlog/${goal.currentScrumNumber}`] as string[] | undefined) ?? []);
    const scrumTasks = tasks.filter(t => (t.fields.scrumNumber as number | undefined) === goal.currentScrumNumber || retained.has(t.id));
    if (scrumTasks.length === 0) return;
    const doneTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (const t of scrumTasks) {
      const status = t.fields.status as string | undefined;
      if (status === 'done') doneTaskIds.push(t.id);
      else if (status === 'permanently_failed') failedTaskIds.push(t.id);
      else return; // at least one current-scrum task is still pending / in-flight — not ready
    }
    this.readyForCompletionEmitted.add(scrumKey);
    log.info(`Goal ${goalId.slice(0, 8)} scrum ${goal.currentScrumNumber} ready for review (creator=${goal.createdBy.slice(0, 8)}, ${doneTaskIds.length} done, ${failedTaskIds.length} failed)`);
    this.changed('goalReadyForCompletion', {
      goalId,
      scrumNumber: goal.currentScrumNumber,
      creatorAgentId: goal.createdBy,
      doneTaskIds,
      failedTaskIds,
    });
    // Direct event to the creator so they don't need to subscribe to changed
    // events. Useful for top-level creators (e.g. Chat) that don't otherwise
    // run an observing loop on goals they create.
    try {
      this.send(event(this.id, goal.createdBy, 'goalReadyForCompletion', {
        goalId,
        scrumNumber: goal.currentScrumNumber,
        creatorAgentId: goal.createdBy,
        doneTaskIds,
        failedTaskIds,
      }));
    } catch { /* best effort — creator may be gone */ }
  }

  /**
   * Sync goal metadata to its per-goal SharedState namespace.
   * Each goal gets namespace `goal-{uuid}` for selective cross-peer sync.
   */
  private async syncGoalToSharedState(goal: Goal): Promise<void> {
    if (!this.sharedStateId) return;
    // Every goal mutation funnels through here, so advertising the goal in the
    // shared catalog at this one point keeps the index complete without
    // touching each of the mutation call sites.
    this.publishCatalogEntry(goal);
    try {
      await this.request(request(this.id, this.sharedStateId, 'set', {
        name: `goal-${goal.id}`,
        key: 'meta',
        value: {
          id: goal.id,
          parentId: goal.parentId,
          title: goal.title,
          description: goal.description,
          status: goal.status,
          createdBy: goal.createdBy,
          creatorName: goal.creatorName,
          creatorPeerId: goal.creatorPeerId,
          childIds: goal.childIds,
          result: goal.result,
          error: goal.error,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
          scratchpad: goal.scratchpad,
          currentScrumNumber: goal.currentScrumNumber,
          interjections: goal.interjections,
        },
        persist: true,
      }));
    } catch { /* best effort */ }
  }

  /** Snapshot learning records before publication; SharedState distributes the same owner state. */
  private async persistLearning(goal: Goal): Promise<void> {
    return withKeyedLock(`${this.id}:learning-persist:${goal.id}`, async () => {
    if (this.storageId) await this.request(request(this.id, this.storageId, 'set', {
      key: `goals:learning:${goal.id}`, value: {version:2,goalState:{status:goal.status,result:goal.result,error:goal.error,updatedAt:goal.updatedAt,lastMeaningfulProgressAt:goal.lastMeaningfulProgressAt},scratchpad:goal.scratchpad},
    }));
    await this.syncGoalToSharedState(goal);
    });
  }

  private setupHandlers(): void {
    describeMessages(this.manifest, [
      { name: "recordPredictionAssessment", description: "TaskReviewer records its interpretation separately from observed execution evidence; repeated assessments are acknowledged without overwriting.", parameters: { "goalId": protocolText, "taskId": protocolText, "step": protocolNumber, "verdict": protocolText, "explanation": protocolText } },
      { name: "getGoalBriefing", description: "Bounded task briefing with selected scratchpad values and references to complete evidence.", parameters: { "goalId": protocolText, "keys?": { kind: 'array', elementType: protocolText } } },
      { name: "recordTaskEvidence", description: "Preserve a task record before terminal notification.", parameters: { "goalId": protocolText, "taskId": protocolText, "record": protocolObject } },
      { name: "recordObservation", description: "Idempotently record an observation for the next scrum.", parameters: { "goalId": protocolText, "operationId": protocolText, "observation": protocolObject } },
      { name: "recordPlan", description: "Record an evidence-backed plan revision; stale revisions conflict.", parameters: { "goalId": protocolText, "operationId": protocolText, "expectedRevision": protocolNumber, "plan": protocolObject } },
      { name: "getBudget", description: "Inspect attributable tokens, cost, time and outstanding reservations across this goal and its children.", parameters: { goalId: protocolText } },
      { name: "configureBudget", description: "Goal creator sets maxTokens/maxCostUsd. Concurrent model calls reserve spend before execution; exhaustion preserves partial sessions.", parameters: { goalId: protocolText, maxTokens: protocolNumber, maxCostUsd: protocolNumber } },
      { name: "pendingReviews", description: "List goal retrospectives awaiting acknowledgement.", parameters: {  } },
      { name: "ackReview", description: "Acknowledge a completed retrospective.", parameters: { "goalId": protocolText } },
      { name: "assessTask", description: "Check required outputs and active task state before completion.", parameters: { "goalId": protocolText, "taskId": protocolText } },
    ]);
    this.on('recordTaskEvidence', async (msg: AbjectMessage) => {
      const { goalId, taskId, record } = msg.payload as { goalId: string; taskId: string; record: unknown };
      const goal = this.goals.get(goalId);
      if (!goal) return { success: false };
      requireNonEmpty(taskId, 'taskId');
      goal.scratchpad[`learning/task/${taskId}`] = record;
      goal.lastMeaningfulProgressAt = Date.now();
      await this.persistLearning(goal);
      return { success: true };
    });
    this.on('recordPredictionAssessment', async (msg: AbjectMessage) => {
      if (msg.routing.from !== await this.discoverDep('TaskReviewer')) throw new Error('Prediction assessments belong to TaskReviewer');
      const { goalId, taskId, step, verdict, explanation } = msg.payload as { goalId: GoalId; taskId: string; step: number; verdict: string; explanation: string };
      const goal = this.goals.get(goalId);
      if (!goal) return { success: false, error: 'Goal evidence unavailable' };
      if (!['supported', 'contradicted', 'unresolved'].includes(verdict) || !explanation?.trim()) return { success: false, error: 'Assessment requires a verdict and explanation grounded in evidence' };
      const task = goal.scratchpad[`learning/task/${taskId}`] as { predictions?: Array<{ step: number; expect?: string; outcome?: string }> } | undefined;
      const observed = goal.scratchpad[`learning/observation/${taskId}:${step}`] as { expect?: string; outcome?: string } | undefined;
      const prediction = task?.predictions?.find(p => p.step === step) ?? observed;
      if (!prediction) return { success: false, error: 'No observed episode at this task and step' };
      if ((!prediction.expect || prediction.outcome === 'unknown') && verdict !== 'unresolved') return { success: false, error: 'An unstated prediction or unobserved outcome remains unknown' };
      const key = `learning/assessment/${taskId}:${step}`;
      if (key in goal.scratchpad) { await this.persistLearning(goal); return { success: true, duplicate: true, assessment: goal.scratchpad[key] }; }
      goal.scratchpad[key] = { taskId, step, verdict, explanation, origin: 'reviewer', at: Date.now() };
      await this.persistLearning(goal);
      return { success: true, assessment: goal.scratchpad[key] };
    });

    this.on('recordObservation', async (msg: AbjectMessage) => {
      const { goalId, operationId, observation } = msg.payload as { goalId: string; operationId: string; observation: unknown };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return { success: false };
      requireNonEmpty(operationId, 'operationId');
      const key = `learning/observation/${operationId}`;
      if (key in goal.scratchpad) { await this.persistLearning(goal); return { success: true, duplicate: true }; }
      goal.scratchpad[key] = { ...(observation as Record<string, unknown>), at: Date.now() };
      goal.lastMeaningfulProgressAt=Date.now();
      await this.persistLearning(goal);
      this.changed('observationRecorded', { goalId, operationId, observation });
      return { success: true };
    });
    this.on('recordScrumCommit', async msg => {
      if (msg.routing.from !== await this.discoverDep('ScrumMaster')) throw new Error('Scrum commits belong to ScrumMaster');
      const { goalId, operationId } = msg.payload as { goalId: string; operationId: string };
      const goal = this.goals.get(goalId);
      if (!goal || !operationId) throw new Error('Unknown goal or missing commit identity');
      goal.scratchpad[`learning/commit/${operationId}`] = true;
      await this.persistLearning(goal);
      return { success: true };
    });
    this.on('recordPlan', async (msg: AbjectMessage) => {
      const { goalId, operationId, expectedRevision, plan } = msg.payload as { goalId: string; operationId: string; expectedRevision: number; plan: Record<string, unknown> };
      return withKeyedLock(`${this.id}:plan:${goalId}`, async () => {
        const goal = this.goals.get(goalId);
        if (!goal || goal.status !== 'active') return { success: false, error: 'Goal is not active' };
        const history = (goal.scratchpad['learning/plans'] as Array<{ revision: number; operationId: string; plan: unknown; at: number }>) ?? [];
        const duplicate = history.find(p => p.operationId === operationId);
        if (duplicate) { await this.persistLearning(goal); return { success: true, revision: duplicate.revision, duplicate: true }; }
        const current = history.at(-1)?.revision ?? 0;
        if (current !== expectedRevision) return { success: false, conflict: true, revision: current };
        history.push({ revision: current + 1, operationId, plan, at: Date.now() });
        goal.scratchpad['learning/plans'] = history;
        goal.lastMeaningfulProgressAt = Date.now();
        await this.persistLearning(goal);
        this.changed('planRevised', { goalId, revision: current + 1, plan });
        return { success: true, revision: current + 1 };
      });
    });
    this.on('pendingReviews', async () => [...this.goals.values()]
      .filter(g => g.scratchpad['learning/review'] === 'pending')
      .map(g => ({ goalId: g.id, outcome: g.error ? 'failed' : 'completed', detail: g.error })));
    this.on('ackReview', async (msg: AbjectMessage) => {
      const { goalId, report } = msg.payload as { goalId: string; report?: { status?: string } };
      const goal = this.goals.get(goalId);
      if (!goal) return { success: false };
      goal.scratchpad['learning/review'] = report?.status === 'partial' ? 'partial' : 'reviewed';
      if (report) goal.scratchpad['learning/reviewOutcome'] = structuredClone(report);
      await this.persistLearning(goal);
      return { success: true };
    });

    this.on('getBudget', async msg => {
      const { goalId } = msg.payload as { goalId: string };
      const goal = this.budgetOwner(goalId);
      return structuredClone(goal.scratchpad['resources'] ?? { usedTokens: 0, usedCostUsd: 0, reservations: {} });
    });
    this.on('configureBudget', async msg => {
      const { goalId, maxTokens, maxCostUsd } = msg.payload as { goalId: string; maxTokens?: number; maxCostUsd?: number };
      const goal = this.budgetOwner(goalId);
      if (msg.routing.from !== goal.createdBy) throw new Error('Only the goal creator may change its budget');
      for (const value of [maxTokens, maxCostUsd]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('Budget limits must be nonnegative finite numbers');
      return withKeyedLock(`${this.id}:budget:${goal.id}`, async () => {
        const resources = (goal.scratchpad['resources'] ?? {}) as Record<string, unknown>;
        goal.scratchpad['resources'] = { ...resources, maxTokens, maxCostUsd };
        await this.persistLearning(goal);
        return { success: true };
      });
    });
    this.on('reserveUsage', async msg => {
      if (msg.routing.from !== await this.discoverDep('LLM')) throw new Error('Only LLM may reserve model usage');
      const p = msg.payload as { goalId: string; operationId: string; taskId?: string; tokens: number; costUsd?: number };
      const goal = this.budgetOwner(p.goalId);
      if (!p.operationId || !Number.isFinite(p.tokens) || p.tokens < 0 || (p.costUsd !== undefined && (!Number.isFinite(p.costUsd) || p.costUsd < 0))) throw new Error('Invalid usage reservation');
      return withKeyedLock(`${this.id}:budget:${goal.id}`, async () => {
        const r: any = structuredClone(goal.scratchpad['resources'] ?? { usedTokens: 0, usedCostUsd: 0, reservations: {}, receipts: {} });
        r.reservations ??= {}; r.receipts ??= {};
        if (r.reservations[p.operationId] || r.receipts[p.operationId]) return { accepted: false, reason: 'Operation already reserved or settled' };
        const reserved = Object.values(r.reservations) as Array<{tokens: number; costUsd?: number}>;
        const tokens = (r.usedTokens ?? 0) + reserved.reduce((sum,v) => sum + v.tokens, 0) + p.tokens;
        const cost = (r.usedCostUsd ?? 0) + reserved.reduce((sum,v) => sum + (v.costUsd ?? 0), 0) + (p.costUsd ?? 0);
        if (r.maxTokens !== undefined && tokens > r.maxTokens) return { accepted: false, reason: 'Goal token budget exhausted', remaining: r.maxTokens - (r.usedTokens ?? 0) };
        if (r.maxCostUsd !== undefined && (p.costUsd === undefined || cost > r.maxCostUsd)) return { accepted: false, reason: 'Goal cost budget exhausted or model price unknown' };
        r.reservations[p.operationId] = { ...p, startedAt: Date.now() };
        goal.scratchpad['resources'] = r; await this.persistLearning(goal);
        return { accepted: true, goalId: goal.id };
      });
    });
    this.on('settleUsage', async msg => {
      if (msg.routing.from !== await this.discoverDep('LLM')) throw new Error('Only LLM may reconcile model usage');
      const p = msg.payload as { goalId: string; operationId: string; tokens?: number; costUsd?: number; error?: string };
      if ([p.tokens, p.costUsd].some(v => v !== undefined && (!Number.isFinite(v) || v < 0))) throw new Error('Invalid usage settlement');
      const goal = this.budgetOwner(p.goalId);
      return withKeyedLock(`${this.id}:budget:${goal.id}`, async () => {
        const r: any = structuredClone(goal.scratchpad['resources']);
        if (r?.receipts?.[p.operationId]) { await this.persistLearning(goal); return { success: true, duplicate: true }; }
        const reservation = r?.reservations?.[p.operationId];
        if (!reservation) throw new Error('Unknown reservation');
        const receipt = { ...p, taskId: reservation.taskId, tokens: p.tokens ?? reservation.tokens,
          costUsd: p.costUsd ?? reservation.costUsd, estimated: p.tokens === undefined || p.costUsd === undefined,
          elapsedMs: Date.now() - reservation.startedAt };
        delete r.reservations[p.operationId]; r.receipts[p.operationId] = receipt;
        r.usedTokens = (r.usedTokens ?? 0) + receipt.tokens;
        r.usedCostUsd = (r.usedCostUsd ?? 0) + (receipt.costUsd ?? 0);
        goal.scratchpad['resources'] = r; await this.persistLearning(goal);
        this.changed('goalBudgetUpdated', { goalId: goal.id, ...r });
        return { success: true };
      });
    });

    this.on('createGoal', async (msg: AbjectMessage) => {
      await this.sweepGoals();
      const { title, parentId, description } = msg.payload as {
        title: string;
        parentId?: GoalId;
        description: string;
      };
      requireNonEmpty(title, 'title');
      requireNonEmpty(description, 'description');

      const goalId = uuidv4() as GoalId;
      const callerId = msg.routing.from;

      const goal: Goal = {
        id: goalId,
        parentId,
        title: title.slice(0, 200),
        description,
        status: 'active',
        createdBy: callerId,
        creatorName: '',
        creatorPeerId: this.selfPeerId,
        progress: [],
        childIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        scratchpad: {},
        currentScrumNumber: 0,
        interjections: [],
      };

      this.goals.set(goalId, goal);
      this.goalOrder.push(goalId);

      // Link to parent
      if (parentId) {
        const parent = this.goals.get(parentId);
        if (parent) {
          parent.childIds.push(goalId);
          parent.updatedAt = Date.now();
        }
      }

      // Create + subscribe to per-goal SharedState namespace
      if (this.sharedStateId) {
        const ns = `goal-${goalId}`;
        try {
          await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
          await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));
        } catch { /* best effort */ }
      }

      log.info(`Goal created: "${goal.title}" (${goalId})`);
      this.changed('goalCreated', { goalId, title: goal.title, description: goal.description, parentId });
      this.syncGoalToSharedState(goal);
      this.saveGoalIndex();

      return { goalId };
    });

    this.on('updateProgress', async (msg: AbjectMessage) => {
      const { goalId, message, phase, agentName } = msg.payload as {
        goalId: GoalId; message: string; phase?: string; agentName?: string;
      };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return;

      // Heartbeats arrive at ~1Hz with identical text ("working"). Collapse
      // consecutive repeats into the prior entry instead of growing the
      // progress array (and the goalUpdated payload shipped to every
      // dependent) without bound, and only log actual transitions.
      const last = goal.progress[goal.progress.length - 1];
      const isRepeat = !!last && last.message === message && last.phase === phase
        && last.agentName === (agentName ?? 'Unknown');
      if (isRepeat) {
        last.timestamp = Date.now();
      } else {
        log.info(`updateProgress ${goalId.slice(0, 8)} phase=${phase ?? '?'} agent=${agentName ?? '?'}: ${message.slice(0, 80)}`);
        goal.progress.push({
          timestamp: Date.now(),
          agentName: agentName ?? 'Unknown',
          message,
          phase,
          peerId: this.selfPeerId,
        });
        if (goal.progress.length > 200) goal.progress.splice(0, goal.progress.length - 200);
        // Publish only real transitions. Heartbeats arrive at ~1Hz and collapse
        // into the prior entry above; re-broadcasting them would flood every
        // collaborator with identical registers.
        this.syncProgressToSharedState(goal);
      }
      goal.updatedAt = Date.now();

      this.changed('goalUpdated', {
        goalId,
        parentId: goal.parentId,
        message,
        phase,
        agentName,
        progress: goal.progress,
      });
    });

    this.on('completeGoal', async (msg: AbjectMessage) => {
      const { goalId, result } = msg.payload as { goalId: GoalId; result?: unknown };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return;

      goal.status = 'completed';
      goal.result = result;
      goal.updatedAt = Date.now();

      goal.scratchpad['learning/review'] = 'pending';
      await this.persistLearning(goal);
      log.info(`Goal completed: "${goal.title}" (${goalId})`);
      this.changed('goalCompleted', { goalId, result });
      this.syncGoalToSharedState(goal);
    });

    /**
     * Increment Goal.currentScrumNumber. Called by ScrumMaster when a scrum
     * decides to plan more work. New tasks added at the incremented number
     * gate the next round's `goalReadyForCompletion` emission.
     */
    this.on('startNextScrum', async msg => {
      const {goalId,operationId,preserveTaskIds=[]}=msg.payload as {goalId:GoalId;operationId?:string;preserveTaskIds?:string[]};
      return withKeyedLock(`${this.id}:round:${goalId}`,async()=>{
        const goal=this.goals.get(goalId);
        if(!goal || goal.status!=='active')throw new Error('Goal is not active');
        const key=operationId?`learning/round/${operationId}`:undefined;
        if(key && goal.scratchpad[key]!==undefined){await this.persistLearning(goal);return {scrumNumber:goal.scratchpad[key],duplicate:true};}
        if (!Array.isArray(preserveTaskIds) || preserveTaskIds.some(id => typeof id !== 'string')) throw new Error('preserveTaskIds must be an array of task IDs');
        if (preserveTaskIds.length) {
          if (!this.tupleSpaceId) throw new Error('TupleSpace unavailable');
          const tasks = await this.request<Array<{ id: string; fields: { status: string } }>>(request(this.id, this.tupleSpaceId, 'scan', {
            namespace: this.getTupleNamespace(goalId), pattern: { goalId },
          }));
          if (preserveTaskIds.some(id => !tasks.some(t => t.id === id && !['superseded', 'cancelled'].includes(t.fields.status)))) {
            throw new Error('Preserved tasks must belong to this goal and must not be cancelled or superseded');
          }
        }
        goal.currentScrumNumber=(goal.currentScrumNumber??0)+1;goal.updatedAt=Date.now();
        goal.scratchpad[`learning/backlog/${goal.currentScrumNumber}`] = [...new Set(preserveTaskIds)];
        if(key)goal.scratchpad[key]=goal.currentScrumNumber;
        await this.persistLearning(goal);
        this.changed('goalUpdated',{goalId,parentId:goal.parentId,message:`Scrum ${goal.currentScrumNumber} planned`,phase:'planning'});
        return {scrumNumber:goal.currentScrumNumber};
      });
    });

    this.on('failGoal', async (msg: AbjectMessage) => {
      const { goalId, error } = msg.payload as { goalId: GoalId; error?: string };
      // A paused goal can still be failed (e.g. the user stops it mid-pause).
      const goal = this.goals.get(goalId);
      if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return;

      goal.status = 'failed';
      goal.error = error;
      goal.updatedAt = Date.now();

      goal.scratchpad['learning/review'] = 'pending';
      await this.persistLearning(goal);
      log.info(`Goal failed: "${goal.title}" (${goalId}) — ${error ?? 'unknown'}`);
      this.changed('goalFailed', { goalId, error });
      this.syncGoalToSharedState(goal);
    });

    /**
     * Freeze a goal: agents stop stepping (AgentAbject gates its OTA loops),
     * pending tasks stop being claimable, and no scrum fires (the ready
     * check requires status 'active'). The user interjects via
     * `appendGoalNote`, then `resumeGoal` continues the sprint.
     */
    this.on('pauseGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: GoalId };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return false;

      goal.status = 'paused';
      goal.updatedAt = Date.now();

      const runtimeId = await this.taskRuntime();
      if (runtimeId) {
        try {
          await this.request(request(this.id, runtimeId, 'pauseTasksByGoal', { goalId }));
        } catch { /* best effort — the claimTask/scrum gates still hold */ }
      }

      log.info(`Goal paused: "${goal.title}" (${goalId})`);
      await this.persistLearning(goal);
      this.changed('goalPaused', { goalId });
      return true;
    });

    this.on('resumeGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: GoalId };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'paused') return false;

      goal.status = 'active';
      goal.updatedAt = Date.now();

      const runtimeId = await this.taskRuntime();
      if (runtimeId) {
        try {
          await this.request(request(this.id, runtimeId, 'resumeTasksByGoal', { goalId }));
        } catch { /* best effort */ }
      }

      log.info(`Goal resumed: "${goal.title}" (${goalId})`);
      await this.persistLearning(goal);
      this.changed('goalResumed', { goalId });
      // The round may have reached all-terminal right as the user paused —
      // re-check so the next scrum isn't lost.
      this.maybeEmitGoalReadyForCompletion(goalId).catch(() => { /* best effort */ });
      return true;
    });

    /**
     * Hard stop: cancel every task (tuples + running agent loops) and fail
     * the goal as 'Stopped by user'. Works from active or paused.
     */
    this.on('stopGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: GoalId };
      const goal = this.goals.get(goalId);
      if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return false;

      const { cancelled } = await this.cancelTasksForGoalInternal(goalId).catch(() => ({ cancelled: 0 }));

      goal.status = 'failed';
      goal.error = 'Stopped by user';
      goal.updatedAt = Date.now();

      log.info(`Goal stopped by user: "${goal.title}" (${goalId}) — ${cancelled} tasks cancelled`);
      goal.scratchpad['learning/review'] = 'deferred:user-stop';
      await this.persistLearning(goal);
      this.changed('goalFailed', { goalId, error: 'Stopped by user' });
      return true;
    });

    /**
     * Queue a user interjection on a running or paused goal. Notes live in
     * goal.interjections (not the scratchpad, so they are never mistaken for
     * task outputs). ScrumMaster reads pending notes at every decision point
     * and marks them incorporated once a committed decision weighed them.
     */
    this.on('appendGoalNote', async (msg: AbjectMessage) => {
      const { goalId, note } = msg.payload as { goalId: GoalId; note: string };
      requireNonEmpty(note, 'note');
      const goal = this.goals.get(goalId);
      if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return false;

      const at = Date.now();
      if (!goal.interjections) goal.interjections = [];
      goal.interjections.push({ note, at, status: 'pending' });
      goal.updatedAt = at;

      log.info(`Goal interjection queued for "${goal.title}" (${goalId}): ${note.slice(0, 80)}`);
      this.changed('goalUpdated', { goalId, parentId: goal.parentId, message: `User note: ${note.slice(0, 120)}` });
      // Dedicated aspect so ScrumMaster can wake mid-round and weigh the note
      // against the plan and in-flight work.
      this.changed('goalInterjection', { goalId, parentId: goal.parentId, note, at });
      this.syncGoalToSharedState(goal);
      return true;
    });

    /**
     * Broadcast a human-readable progress line for a goal (shows up in the
     * chat activity bubble and terminal goal panels). For orchestrators that
     * want to acknowledge something without touching goal state.
     */
    this.on('reportGoalProgress', async (msg: AbjectMessage) => {
      const { goalId, message } = msg.payload as { goalId: GoalId; message: string };
      requireNonEmpty(message, 'message');
      const goal = this.goals.get(goalId);
      if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return false;
      goal.updatedAt = Date.now();
      this.changed('goalUpdated', { goalId, parentId: goal.parentId, message: message.slice(0, 300) });
      return true;
    });

    /**
     * ScrumMaster asks the user a question: the goal pauses (agents stop at
     * their next phase boundary, scrums stop firing, staleness sweeps ignore
     * it) and `goalClarificationRequested` reaches every goal subscriber —
     * Chat and terminal clients render the question; the user's next message
     * queues as an interjection and resumes the goal.
     */
    this.on('requestClarification', async (msg: AbjectMessage) => {
      const { goalId, question } = msg.payload as { goalId: GoalId; question: string };
      requireNonEmpty(question, 'question');
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return false;

      goal.status = 'paused';
      goal.updatedAt = Date.now();
      const runtimeId = await this.taskRuntime();
      if (runtimeId) {
        try {
          await this.request(request(this.id, runtimeId, 'pauseTasksByGoal', { goalId }));
        } catch { /* best effort — the claimTask/scrum gates still hold */ }
      }

      log.info(`Clarification requested for "${goal.title}" (${goalId}): ${question.slice(0, 80)}`);
      await this.persistLearning(goal);
      this.changed('goalPaused', { goalId });
      this.changed('goalClarificationRequested', { goalId, parentId: goal.parentId, question });
      return true;
    });

    /**
     * Flip pending interjections (up to a timestamp) to incorporated. Called
     * by ScrumMaster only when a scrum COMMITS a decision that weighed them,
     * so a crashed or retried scrum re-reads them as pending.
     */
    this.on('markInterjectionsIncorporated', async (msg: AbjectMessage) => {
      const { goalId, upTo } = msg.payload as { goalId: GoalId; upTo: number };
      const goal = this.goals.get(goalId);
      if (!goal?.interjections?.length) return 0;
      let flipped = 0;
      for (const entry of goal.interjections) {
        if (entry.status === 'pending' && entry.at <= upTo) {
          entry.status = 'incorporated';
          flipped++;
        }
      }
      if (flipped > 0) {
        goal.updatedAt = Date.now();
        this.syncGoalToSharedState(goal);
      }
      return flipped;
    });

    /**
     * Cancel every non-terminal task of a goal WITHOUT failing the goal —
     * the re-plan-now primitive. Completed/failed tuples stay (the review
     * record survives); pending tuples are removed; in-flight agents cancel
     * cooperatively at their next phase boundary, exactly like stopGoal's
     * cancellation. The goal itself stays active so the caller can dispatch
     * a fresh round immediately.
     */
    this.on('cancelOutstandingTasks', async (msg: AbjectMessage) => {
      const { goalId, preserveTaskIds = [] } = msg.payload as { goalId: GoalId; preserveTaskIds?: string[] };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return { cancelled: 0, safe: false, inactive: true, error: 'Goal is no longer active' };
      if (!this.tupleSpaceId) return { cancelled: 0, safe: false, error: 'TupleSpace unavailable' };

      const runtimeId = await this.taskRuntime();
      if (!runtimeId) return { cancelled: 0, safe: false, error: 'Task runtime unavailable' };

      const ns = this.getTupleNamespace(goalId);
      const tasks = await this.request<Array<{ id: string; fields: Record<string, unknown>; claimedBy?: string }>>(
        request(this.id, this.tupleSpaceId, 'scan', { pattern: { goalId }, namespace: ns })
      );

      let cancelled = 0;
      for (const task of tasks) {
        const status = String(task.fields?.status ?? 'pending');
        if (preserveTaskIds.includes(task.id) || ['done','failed','permanently_failed','cancelled','superseded'].includes(status)) continue;
        try {
          if (task.claimedBy) {
            try {
              await this.request(request(this.id, this.tupleSpaceId!, 'release', { tupleId: task.id, namespace: ns }));
            } catch { /* best effort */ }
          }
          await this.request(request(this.id, this.tupleSpaceId!, 'update', { tupleId: task.id, namespace: ns, expectedFields: { status }, fields: { status: 'superseded' } }));
          this.emittedTerminalTasks.delete(task.id);
          cancelled++;
        } catch { /* tuple may already be gone */ }
      }

      try {
        await this.request(request(this.id, runtimeId, 'cancelTasksByGoal', { goalId, preserveTaskIds }));
      } catch (err) { return { cancelled, safe: false, error: String(err) }; }

      if (cancelled > 0) {
        goal.updatedAt = Date.now();
        this.changed('goalUpdated', {
          goalId, parentId: goal.parentId,
          message: `Re-planning: ${cancelled} outstanding task(s) cancelled to make way for the new plan`,
        });
      }
      const receipt = await this.request<{ safe: boolean; pending: unknown }>(request(this.id, runtimeId, 'awaitGoalQuiescence', { goalId, preserveTaskIds }), 15000);
      return { cancelled, ...receipt };
    });

    this.on('getGoalBriefing', async (msg: AbjectMessage) => {
      const { goalId, keys = [] } = msg.payload as { goalId: GoalId; keys?: string[] };
      const goal = this.goals.get(goalId);
      if (!goal) return null;
      const all = Object.keys(goal.scratchpad);
      const selected = keys.length ? keys : all.filter(k => !k.startsWith('learning/') && !k.startsWith('tasks/'));
      const scratchpad: Record<string, unknown> = {};
      let remaining = 12000;
      const omitted: string[] = [];
      for (const key of selected) {
        if (!(key in goal.scratchpad)) continue;
        const value = goal.scratchpad[key], text = JSON.stringify(value) ?? 'null';
        if (text.length <= Math.min(3000, remaining)) { scratchpad[key] = value; remaining -= text.length; }
        else omitted.push(key);
      }
      return { title: goal.title, description: goal.description, status: goal.status, scratchpad,
        scratchpadIndex: all.slice(0, 100), scratchpadKeyCount: all.length, omitted: omitted.slice(0, 100), omittedCount: omitted.length,
        readMore: 'Use readGoalData({goalId,key}) for complete values; getGoal({goalId}) lists all keys.' };
    });

    this.on('getGoal', async (msg: AbjectMessage) => {
      await this.sweepGoals();
      const { goalId } = msg.payload as { goalId: GoalId };
      return structuredClone(this.goals.get(goalId) ?? null);
    });

    this.on('listGoals', async (msg: AbjectMessage) => {
      await this.sweepGoals();
      const { status, parentId, includeArchived } = (msg.payload ?? {}) as {
        status?: string; parentId?: GoalId; includeArchived?: boolean;
      };
      return this.goalOrder
        .map(id => this.goals.get(id))
        .filter((g): g is Goal => {
          if (!g) return false;
          if (!includeArchived && g.status === 'archived') return false;
          if (status && g.status !== status) return false;
          if (parentId !== undefined && g.parentId !== parentId) return false;
          return true;
        });
    });

    this.on('clearCompleted', async () => {
      const goalsToClear: Goal[] = [];
      const now = Date.now();

      for (const [, goal] of this.goals) {
        if (goal.scratchpad['learning/review'] !== 'pending' && (goal.status === 'completed' || goal.status === 'failed' || goal.status === 'archived')) {
          goalsToClear.push(goal);
        }
      }

      for (const goal of goalsToClear) {
        // Remove task tuples from TupleSpace
        if (this.tupleSpaceId) {
          const ns = this.getTupleNamespace(goal.id as GoalId);
          try {
            const tasks = await this.request<Array<{ id: string; claimedBy?: string }>>(
              request(this.id, this.tupleSpaceId, 'scan', { pattern: { goalId: goal.id }, namespace: ns })
            );
            for (const task of tasks) {
              try {
                if (task.claimedBy) {
                  await this.request(request(this.id, this.tupleSpaceId!, 'release', { tupleId: task.id, namespace: ns }));
                }
                await this.request(request(this.id, this.tupleSpaceId!, 'remove', { tupleId: task.id, namespace: ns }));
                this.emittedTerminalTasks.delete(task.id);
              } catch { /* best effort */ }
            }
          } catch { /* best effort */ }
        }

        // Remove entire SharedState namespace (deletes persisted data + unsubscribes)
        if (this.sharedStateId) {
          this.publishCatalogTombstone(goal.id);
          try {
            await this.request(request(this.id, this.sharedStateId, 'removeNamespace', { name: `goal-${goal.id}` }));
          } catch { /* best effort */ }
        }

        // Remove from in-memory map entirely (not just archive)
        this.goals.delete(goal.id);
        const idx = this.goalOrder.indexOf(goal.id);
        if (idx !== -1) this.goalOrder.splice(idx, 1);
      }

      this.saveGoalIndex();
      this.changed('goalsCleared', {});
    });

    this.on('getStats', async () => {
      await this.sweepGoals();
      let active = 0, paused = 0, completed = 0, failed = 0, archived = 0;
      for (const [, goal] of this.goals) {
        switch (goal.status) {
          case 'active': active++; break;
          case 'paused': paused++; break;
          case 'completed': completed++; break;
          case 'failed': failed++; break;
          case 'archived': archived++; break;
        }
      }
      return { active, paused, completed, failed, archived, total: this.goals.size };
    });

    // ── Task convenience methods (delegate to TupleSpace) ──

    this.on('addTask', async (msg: AbjectMessage) => {
      const { goalId, description, data, dependsOn, produces, consumes, assignedAgentId, scrumNumber, operationId } = msg.payload as {
        goalId: string; description: string; data?: unknown; dependsOn?: string[];
        produces?: Array<{ key: string; description: string }>;
        consumes?: string[];
        /** Direct assignment from ScrumMaster — the agent that will run this task. */
        assignedAgentId?: string;
        /** Scrum round this task belongs to. `goalReadyForCompletion` fires when every task at the goal's currentScrumNumber is terminal. */
        scrumNumber?: number; operationId?:string;
      };
      requireNonEmpty(goalId, 'goalId');
      requireNonEmpty(description, 'description');

      const goal = this.goals.get(goalId as GoalId);
      if (!goal) return { error: 'Goal not found' };

      // Refuse tasks for terminated goals. Under the Scrum model, ScrumMaster
      // is the only party adding tasks, and a scrum's first action is a
      // status check before planning. If we get here for a non-active goal
      // it means something raced (e.g. GoalObserver's staleness backstop
      // ran while a scrum was already mid-plan); silently re-activating
      // hides the bug and lets work continue on a goal Chat already gave
      // up on.
      if (goal.status !== 'active') {
        log.warn(`addTask: refused — goal ${goalId.slice(0, 8)} is ${goal.status}, not active`);
        return { error: `Goal is ${goal.status}, cannot add tasks` };
      }

      // Resolve the task's effective scrum number. ScrumMaster passes one
      // explicitly; legacy callers omit it, in which case we attribute to the
      // goal's currentScrumNumber so existing flows continue to work.
      const effectiveScrumNumber = scrumNumber ?? goal.currentScrumNumber;

      // Re-arm the ready-for-completion check for THIS scrum so the creator
      // gets a fresh signal once every task at the new task's scrum number
      // reaches terminal state. Re-key by (goalId, scrumNumber).
      this.readyForCompletionEmitted.delete(`${goalId}#${effectiveScrumNumber}`);

      if (!this.tupleSpaceId) return { error: 'TupleSpace not available' };

      const ns = this.getTupleNamespace(goalId as GoalId);
      const result = await this.request<{ tupleId: string }>(
        request(this.id, this.tupleSpaceId, 'put', {
          namespace: ns, operationId,
          fields: {
            goalId, status: 'pending', description, data,
            attempts: 0, maxAttempts: 3, failureHistory: [],
            dependsOn: dependsOn ?? [],
            produces: produces ?? [],
            consumes: consumes ?? [],
            assignedAgentId,
            scrumNumber: effectiveScrumNumber,
          },
        })
      );
      const contractParts: string[] = [];
      if (produces?.length) contractParts.push(`produces=[${produces.map(p => p.key).join(',')}]`);
      if (consumes?.length) contractParts.push(`consumes=[${consumes.join(',')}]`);
      if (assignedAgentId) contractParts.push(`assigned=${assignedAgentId.slice(0, 8)}`);
      contractParts.push(`scrum=${effectiveScrumNumber}`);
      const contractSuffix = ` (${contractParts.join(' ')})`;
      log.info(`Task added for goal ${goalId}: "${description.slice(0, 60)}"${dependsOn?.length ? ` (depends on ${dependsOn.length} task(s))` : ''}${contractSuffix}`);
      return { taskId: result.tupleId };
    });

    this.on('claimTask', async (msg: AbjectMessage) => {
      const { goalId, type } = (msg.payload ?? {}) as { goalId?: string; type?: string };
      if (!this.tupleSpaceId) { log.info(`claimTask — no TupleSpace`); return null; }

      // A paused goal's tasks are frozen, not claimable.
      if (goalId && this.goals.get(goalId as GoalId)?.status === 'paused') {
        log.info(`claimTask — goal ${goalId.slice(0, 8)} is paused, nothing claimable`);
        return null;
      }

      const pattern: Record<string, unknown> = { status: 'pending' };
      if (goalId) pattern.goalId = goalId;
      if (type) pattern.type = type;
      log.info(`claimTask pattern=${JSON.stringify(pattern)} from=${msg.routing.from.slice(0, 8)}`);

      const ns = goalId ? this.getTupleNamespace(goalId as GoalId) : undefined;
      const result = await this.request(
        request(this.id, this.tupleSpaceId, 'claim', { pattern, ...(ns ? { namespace: ns } : {}) })
      );
      log.info(`claimTask result=${result ? 'claimed' : 'none'}`);
      return result;
    });

    this.on('updateTaskFields', async (msg: AbjectMessage) => {
      const { goalId, taskId, fields } = msg.payload as { goalId: string; taskId: string; fields: Record<string, unknown> };
      if (!this.tupleSpaceId) return false;
      const ns = this.getTupleNamespace(goalId as GoalId);
      return this.request(request(this.id, this.tupleSpaceId, 'update', {
        namespace: ns, tupleId: taskId, fields,
      }));
    });

    this.on('admitTask', async msg => {
      const { taskId, goalId } = msg.payload as { taskId:string; goalId:string };
      const goal=this.goals.get(goalId);
      if (!goal || goal.status!=='active' || !this.tupleSpaceId) return { accepted:false, reason:'Goal is not active' };
      const tasks=await this.request<Array<{id:string;fields:Record<string,unknown>}>>(request(this.id,this.tupleSpaceId,'scan',{namespace:this.getTupleNamespace(goalId as GoalId),pattern:{goalId}}));
      const task=tasks.find(t=>t.id===taskId);
      return task && !['done','failed','permanently_failed','cancelled','superseded'].includes(String(task.fields.status))
        ? {accepted:true} : {accepted:false,reason:'Task was removed, settled or superseded'};
    });

    this.on('assessTask', async (msg: AbjectMessage) => {
      const { taskId, goalId } = msg.payload as { taskId: string; goalId: string };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active' || !this.tupleSpaceId) return { accepted: false, reason: 'Goal is not active' };
      const tuples = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(request(this.id, this.tupleSpaceId, 'scan', {
        namespace: this.getTupleNamespace(goalId), pattern: { goalId },
      }));
      const tuple = tuples.find(t => t.id === taskId);
      if (!tuple || ['cancelled', 'superseded', 'permanently_failed'].includes(String(tuple.fields.status))) return { accepted: false, reason: 'Task attempt is no longer active' };
      const missing = ((tuple.fields.produces as Array<{ key: string }>) ?? []).filter(p => !(p.key in goal.scratchpad) && p.key !== `tasks/${taskId}/result`);
      return { accepted: missing.length === 0, reason: missing.length ? `Missing required outputs: ${missing.map(p => p.key).join(', ')}` : undefined };
    });

    this.on('completeTask', async (msg: AbjectMessage) => {
      const { taskId, result, goalId, evidence } = msg.payload as { taskId: string; result?: unknown; goalId?: string; evidence?: unknown };
      requireNonEmpty(taskId, 'taskId');
      if (!this.tupleSpaceId || !goalId) return { accepted: false, reason: 'Task settlement requires a goal and TupleSpace' };
      return withKeyedLock(`${this.id}:settle:${taskId}`, async () => {
        const goal = this.goals.get(goalId);
        if (!goal || goal.status !== 'active') return { accepted: false, reason: 'Goal is not active' };
        const ns = this.getTupleNamespace(goalId);
        const tuples = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
          request(this.id, this.tupleSpaceId!, 'scan', { namespace: ns, pattern: { goalId } }),
        );
        const tuple = tuples?.find(t => t.id === taskId);
        if (!tuple) return { accepted: false, reason: 'Task does not belong to this goal' };
        if (tuple.fields.status === 'done') {
          goal.scratchpad[`tasks/${taskId}/result`] = tuple.fields.result;
          goal.scratchpad[`tasks/${taskId}/acceptance`] = { evidence: tuple.fields.evidence, at: tuple.fields.acceptedAt };
          await this.persistLearning(goal);
          return { accepted: true, duplicate: true };
        }
        if (['failed', 'permanently_failed', 'cancelled', 'superseded'].includes(String(tuple.fields.status))) return { accepted: false, reason: 'Task attempt is no longer active' };
        const produces = (tuple.fields.produces as Array<{ key: string }>) ?? [];
        const missing = produces.filter(p => !(p.key in (goal.scratchpad ?? {})) && p.key !== `tasks/${taskId}/result`);
        if (missing.length) return { accepted: false, reason: `Missing required outputs: ${missing.map(p => p.key).join(', ')}` };
        // TupleSpace compares at the receiver, in the same mutation queue as
        // failure/cancellation updates. A late acceptance cannot revive them.
        const updated = await this.request(request(this.id, this.tupleSpaceId!, 'update', {
          namespace: ns, tupleId: taskId, expectedFields: { status: tuple.fields.status },
          fields: { status: 'done', result, evidence, acceptedAt: Date.now() },
        }));
        if (!updated) return { accepted: false, reason: 'Task changed during settlement' };
        goal.scratchpad ??= {};
        goal.scratchpad[`tasks/${taskId}/result`] = result;
        goal.scratchpad[`tasks/${taskId}/acceptance`] = { evidence, at: Date.now() };
        goal.updatedAt = Date.now();
        await this.syncScratchKeyToSharedState(goal, `tasks/${taskId}/result`, result);
        await this.syncGoalToSharedState(goal);
        await this.persistLearning(goal);
        this.emittedTerminalTasks.add(taskId);
        this.changed('taskCompleted', { taskId, goalId, result, evidence });
        this.changed('taskUnblocked', { goalId, completedTaskId: taskId });
        this.maybeEmitGoalReadyForCompletion(goalId).catch(() => {});
        return { accepted: true };
      });
    });

    this.on('failTask', async (msg: AbjectMessage) => {
      const { taskId, error, goalId, agentName, agentId } = msg.payload as {
        taskId: string; error?: string; goalId?: string; agentName?: string; agentId?: string;
      };
      requireNonEmpty(taskId, 'taskId');
      if (!this.tupleSpaceId) return false;

      log.info(`failTask ${taskId.slice(0, 8)} agent=${agentName ?? '?'} error="${(error ?? '').slice(0, 80)}" from=${msg.routing.from.slice(0, 8)}`);

      const ns = goalId ? this.getTupleNamespace(goalId as GoalId) : undefined;

      // Read current tuple to get failure tracking fields
      let currentFields: Record<string, unknown> = {};
      try {
        const scanResult = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
          request(this.id, this.tupleSpaceId, 'scan', { pattern: {}, ...(ns ? { namespace: ns } : {}) })
        );
        const tuple = scanResult.find(t => t.id === taskId);
        if (tuple) currentFields = tuple.fields;
      } catch (err) {
        log.warn(`failTask ${taskId.slice(0, 8)} scan failed:`, err instanceof Error ? err.message : String(err));
      }

      if (['done', 'cancelled', 'superseded', 'permanently_failed'].includes(String(currentFields.status))) return false;
      const failureHistory = (currentFields.failureHistory as Array<{ agent: string; agentId: string; error: string; timestamp: number }>) ?? [];
      const attempts = ((currentFields.attempts as number) ?? 0) + 1;

      // Append failure record
      failureHistory.push({
        agent: agentName ?? 'unknown',
        agentId: agentId ?? 'unknown',
        error: error ?? 'unknown error',
        timestamp: Date.now(),
      });

      // No per-task retry budget. In the Scrum design, a failed task ends the
      // current scrum (for that task) and the failure context flows into
      // the next scrum, which decides whether to schedule a corrective task in
      // the next scrum. The retry budget that used to live here predates
      // Scrum and would now silently swallow failures the planner needs to
      // see.
      log.info(`failTask ${taskId.slice(0, 8)} — PERMANENTLY FAILED (attempt ${attempts})`);
      const updateResult = await this.request(
        request(this.id, this.tupleSpaceId, 'update', {
          tupleId: taskId,
          expectedFields: { status: currentFields.status },
          fields: { status: 'permanently_failed', error, attempts, failureHistory },
          ...(ns ? { namespace: ns } : {}),
        })
      );
      if (!updateResult) return false;
      try {
        await this.request(request(this.id, this.tupleSpaceId, 'release', { tupleId: taskId, ...(ns ? { namespace: ns } : {}) }));
      } catch { /* best effort */ }
      this.emittedTerminalTasks.add(taskId);
      this.changed('taskPermanentlyFailed', { taskId, goalId, error, attempts });
      if (goalId) {
        this.maybeEmitGoalReadyForCompletion(goalId as GoalId).catch(() => { /* best effort */ });
      }
      return updateResult;
    });

    this.on('getTasksForGoal', async (msg: AbjectMessage) => {
      const { goalId, status } = msg.payload as { goalId: string; status?: string };
      requireNonEmpty(goalId, 'goalId');
      if (!this.tupleSpaceId) return [];

      const ns = this.getTupleNamespace(goalId as GoalId);
      const pattern: Record<string, unknown> = { goalId };
      if (status) pattern.status = status;

      return this.request(
        request(this.id, this.tupleSpaceId, 'scan', { pattern, namespace: ns })
      );
    });

    this.on('getResultsForGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      requireNonEmpty(goalId, 'goalId');
      if (!this.tupleSpaceId) return [];

      const ns = this.getTupleNamespace(goalId as GoalId);
      return this.request(
        request(this.id, this.tupleSpaceId, 'scan', {
          pattern: { goalId, status: 'done' },
          namespace: ns,
        })
      );
    });

    this.on('subscribeGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      requireNonEmpty(goalId, 'goalId');

      // Already tracking this goal locally
      if (this.goals.has(goalId as GoalId)) {
        return this.goals.get(goalId as GoalId) ?? null;
      }

      if (!this.sharedStateId) return null;

      const ns = `goal-${goalId}`;
      await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
      await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));

      if (this.tupleSpaceId) {
        try {
          const tupleNs = this.getTupleNamespace(goalId as GoalId);
          await this.request(request(this.id, this.tupleSpaceId, 'ensureNamespace', { namespace: tupleNs }));
        } catch { /* best effort */ }
      }

      // Load current metadata
      try {
        const all = await this.request<Record<string, unknown>>(
          request(this.id, this.sharedStateId, 'getAll', { name: ns })
        );
        const meta = all?.meta;
        if (meta && typeof meta === 'object' && 'id' in (meta as object)) {
          const goalData = meta as Goal;
          const goal: Goal = {
            ...goalData,
            progress: goalData.progress ?? [],
            scratchpad: goalData.scratchpad ?? {},
            description: goalData.description ?? goalData.title,
          };
          this.goals.set(goal.id, goal);
          if (!this.goalOrder.includes(goal.id)) {
            this.goalOrder.push(goal.id);
          }
          this.saveGoalIndex();
          this.changed('goalCreated', { goalId: goal.id, title: goal.title, description: goal.description, parentId: goal.parentId });
          // Replay every collaborative register we missed while not subscribed,
          // then announce ourselves to the peers already on this goal.
          this.applyRemoteRegisters(goal.id, all);
          this.announceCollaborator(goal.id);
          return goal;
        }
      } catch { /* Goal may not exist yet */ }

      // Namespace exists but no meta yet — add to index so we get updates
      this.goalOrder.push(goalId as GoalId);
      this.saveGoalIndex();
      return null;
    });

    this.on('writeGoalData', async (msg: AbjectMessage) => {
      const { goalId, key, value } = msg.payload as { goalId: GoalId; key: string; value: unknown };
      requireNonEmpty(goalId, 'goalId');
      requireNonEmpty(key, 'key');
      const goal = this.goals.get(goalId);
      if (!goal) return { success: false };
      goal.scratchpad[key] = value;
      goal.updatedAt = Date.now();
      this.changed('goalUpdated', { goalId, message: `scratchpad.${key} updated` });
      // The authoritative value for a single key is its own register. `meta` is
      // still written below (it carries title/status/childIds), but routing the
      // key through `meta` alone would let two collaborators writing different
      // keys concurrently clobber each other.
      this.syncScratchKeyToSharedState(goal, key, value);
      this.syncGoalToSharedState(goal);
      return { success: true };
    });

    this.on('updateTaskProgress', async (msg: AbjectMessage) => {
      const { goalId, taskId, status, message, agentName } = msg.payload as {
        goalId: GoalId; taskId: string; status: string; message?: string; agentName?: string;
      };
      requireNonEmpty(goalId, 'goalId');
      requireNonEmpty(taskId, 'taskId');
      requireNonEmpty(status, 'status');

      const record: RemoteTaskProgress = {
        taskId, goalId, status, message, agentName,
        peerId: this.selfPeerId,
        updatedAt: Date.now(),
      };
      this.remoteTasks.set(this.remoteTaskKey(goalId, taskId), record);
      this.setRegister(goalId, `task:${taskId}`, record);
      this.changed('taskProgress', record);
      return { success: true };
    });

    this.on('getCollaboratorTasks', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: GoalId };
      requireNonEmpty(goalId, 'goalId');
      const prefix = `${goalId}::`;
      return Array.from(this.remoteTasks.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    });

    this.on('getCollaborators', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: GoalId };
      requireNonEmpty(goalId, 'goalId');
      return Array.from(this.collaborators.get(goalId)?.values() ?? []);
    });

    // Pull the whole shared namespace and replay it. Callers use this after a
    // reconnect, when the individual `stateChanged` events were missed.
    this.on('reconcileGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: GoalId };
      requireNonEmpty(goalId, 'goalId');
      if (!this.sharedStateId || !this.goals.has(goalId)) return { reconciled: 0 };
      try {
        const all = await this.request<Record<string, unknown>>(
          request(this.id, this.sharedStateId, 'getAll', { name: this.goalNamespace(goalId) })
        );
        this.applyRemoteRegisters(goalId, all);
        this.announceCollaborator(goalId);
        return { reconciled: Object.keys(all ?? {}).length };
      } catch (err) {
        log.warn(`reconcileGoal failed: ${err instanceof Error ? err.message : String(err)}`);
        return { reconciled: 0 };
      }
    });

    this.on('readGoalData', async (msg: AbjectMessage) => {
      const { goalId, key } = msg.payload as { goalId: GoalId; key?: string };
      requireNonEmpty(goalId, 'goalId');
      const goal = this.goals.get(goalId);
      if (!goal) return null;
      if (key) return goal.scratchpad[key] ?? null;
      return goal.scratchpad;
    });

    this.on('cancelPendingTasks', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      requireNonEmpty(goalId, 'goalId');
      if (!this.tupleSpaceId) return { cancelled: 0 };

      const ns = this.getTupleNamespace(goalId as GoalId);
      const tasks = await this.request<Array<{ id: string; fields: Record<string, unknown>; claimedBy?: string }>>(
        request(this.id, this.tupleSpaceId, 'scan', { pattern: { goalId, status: 'pending' }, namespace: ns })
      );

      let cancelled = 0;
      for (const task of tasks) {
        try {
          if (task.claimedBy) {
            try {
              await this.request(request(this.id, this.tupleSpaceId!, 'release', { tupleId: task.id, namespace: ns }));
            } catch { /* best effort */ }
          }
          await this.request(request(this.id, this.tupleSpaceId!, 'remove', { tupleId: task.id, namespace: ns }));
          this.emittedTerminalTasks.delete(task.id);
          cancelled++;
        } catch { /* best effort */ }
      }

      return { cancelled };
    });

    this.on('cancelTasksForGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      requireNonEmpty(goalId, 'goalId');
      return this.cancelTasksForGoalInternal(goalId);
    });

    this.on('updateTaskAttempts', async (msg: AbjectMessage) => {
      const { taskId, goalId } = msg.payload as { taskId: string; goalId?: string };
      requireNonEmpty(taskId, 'taskId');
      if (!this.tupleSpaceId) return false;

      const ns = goalId ? this.getTupleNamespace(goalId as GoalId) : undefined;

      // Read current tuple to get attempts
      let currentAttempts = 0;
      try {
        const scanResult = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
          request(this.id, this.tupleSpaceId, 'scan', { pattern: {}, ...(ns ? { namespace: ns } : {}) })
        );
        const tuple = scanResult.find(t => t.id === taskId);
        if (tuple) currentAttempts = (tuple.fields.attempts as number) ?? 0;
      } catch { /* best effort */ }

      return this.request(
        request(this.id, this.tupleSpaceId, 'update', {
          tupleId: taskId,
          fields: { attempts: currentAttempts + 1 },
          ...(ns ? { namespace: ns } : {}),
        })
      );
    });

    // Changed handler — routes TupleSpace and SharedState events
    this.on('changed', async (msg: AbjectMessage) => {
      const fromId = msg.routing.from;
      const { aspect, value: eventValue } = msg.payload as { aspect: string; value?: unknown };

      // ── TupleSpace tupleUpdated: detect remote terminal status transitions ──
      if (fromId === this.tupleSpaceId && aspect === 'tupleUpdated' && eventValue) {
        const tuple = eventValue as { id: string; fields: Record<string, unknown> };
        const taskId = tuple.id;
        const status = tuple.fields?.status as string | undefined;
        const goalId = tuple.fields?.goalId as string | undefined;

        if (status === 'permanently_failed' && !this.emittedTerminalTasks.has(taskId)) {
          this.emittedTerminalTasks.add(taskId);
          const err = (tuple.fields?.error as string) ?? 'Task permanently failed (remote)';
          const attempts = (tuple.fields?.attempts as number) ?? 0;
          log.info(`Remote permanently_failed detected for ${taskId.slice(0, 8)}`);
          this.changed('taskPermanentlyFailed', { taskId, goalId, error: err, attempts });
        }
        if (status === 'done' && !this.emittedTerminalTasks.has(taskId)) {
          this.emittedTerminalTasks.add(taskId);
          const result = tuple.fields?.result;
          log.info(`Remote task completion detected for ${taskId.slice(0, 8)}`);
          this.changed('taskCompleted', { taskId, goalId, result });
        }
        return;
      }

      // ── SharedState: merge remote updates for per-goal namespaces ──
      if (fromId !== this.sharedStateId) return;
      if (aspect !== 'stateChanged') return;

      const stateChange = eventValue as { name?: string; key?: string; value?: unknown } | undefined;
      if (!stateChange) return;
      const { name: namespace, key, value } = stateChange;

      // The shared catalog drives discovery of goals owned by other peers.
      if (namespace === this.catalogNamespace) {
        void this.handleCatalogEntry(key, value);
        return;
      }
      log.info(`SharedState changed: ns=${namespace ?? '?'} key=${key ?? '?'}`);
      if (!namespace || !key) return;
      if (!namespace.startsWith('goal-')) return;

      // ── Collaborative registers (Phase 3) ──
      // Scratchpad keys, per-peer progress logs, collaborator task state and
      // presence each own their own register, so concurrent writes by different
      // collaborators merge instead of overwriting one another.
      if (key !== 'meta') {
        this.applyRemoteRegister(namespace.slice('goal-'.length) as GoalId, key, value);
        return;
      }

      const goalId = namespace.slice('goal-'.length) as GoalId;
      if (!value || typeof value !== 'object' || !('id' in (value as object))) return;

      const remote = value as Goal;
      const local = this.goals.get(goalId);

      if (!local) {
        // New goal from remote peer — add it
        const goal: Goal = { ...remote, progress: remote.progress ?? [], scratchpad: remote.scratchpad ?? {} };
        this.goals.set(goal.id, goal);
        if (!this.goalOrder.includes(goal.id)) {
          this.goalOrder.push(goal.id);
        }
        this.saveGoalIndex();
        this.changed('goalCreated', { goalId: goal.id, title: goal.title, description: goal.description, parentId: goal.parentId });
        return;
      }

      // Merge: newer updatedAt wins, but never revert a terminal status
      const localTerminal = local.status === 'completed' || local.status === 'failed' || local.status === 'archived';
      const remoteTerminal = remote.status === 'completed' || remote.status === 'failed' || remote.status === 'archived';
      if (localTerminal && !remoteTerminal) return;

      if (remote.updatedAt > local.updatedAt) {
        local.title = remote.title;
        local.status = remote.status;
        local.childIds = remote.childIds;
        local.result = remote.result;
        local.error = remote.error;
        this.mergeRemoteScratchpad(local, remote.scratchpad);
        local.updatedAt = remote.updatedAt;
        this.changed('goalUpdated', { goalId, message: 'Remote update', progress: local.progress });
      }
    });
  }
}

export const GOAL_MANAGER_ID = 'abjects:goal-manager' as AbjectId;
