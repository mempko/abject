/**
 * TaskReviewer - post-task learning loop.
 *
 * Separates "doing" from "learning": agents finish their tasks without
 * doubling as their own historians, and this object reviews finished work
 * afterwards, distilling durable knowledge into KnowledgeBase (origin
 * 'reviewer'), judging which injected knowledge entries actually helped
 * (markUseful), and packaging reusable multi-step procedures as skills
 * that land disabled pending user approval.
 *
 * It is also the sole pattern smith: goal reviews receive the goal's
 * execution record (ScrumMaster's scrum/plan scratchpad entry) and, when a
 * recurring shape emerges, the reviewer grows the workspace's generative
 * pattern language (KnowledgeBase entries of type 'pattern' with
 * named Context/Forces/Therefore sections and links to related patterns)
 * via the save_pattern / update_pattern actions. ScrumMaster records what
 * happened; this object decides what it means.
 *
 * Review timing: goal-bound tasks are reviewed together when their goal
 * completes or fails, because a task's own "done" is only a claim; the
 * goal's outcome decides whether its approaches count as "what worked".
 * Standalone tasks (no goal) are reviewed on an every-Nth-completion
 * cadence per agent, since they never get a goal-terminal signal.
 *
 * It is also the curation engine behind the knowledge browser's Curate
 * button: an on-demand pass that merges near-duplicate agent/reviewer
 * entries into umbrella entries (fail-closed: every merge must name the
 * entries it absorbs, absorbed entries are archived, never deleted) and
 * archives obsolete ones. There is no scheduled curation; the user
 * triggers it.
 *
 * Strictly per-workspace: it reviews only this workspace's tasks and
 * touches only this workspace's KnowledgeBase.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, requireNonEmpty, invariant } from '../core/contracts.js';
import { makePattern, readPattern, serializePattern, PATTERN_FIELDS } from '../core/pattern.js';
import type { AgentAction } from './agent-abject.js';
import { Log } from '../core/timed-log.js';

const log = new Log('TASK-REVIEWER');

const TASK_REVIEWER_INTERFACE = 'abjects:task-reviewer' as InterfaceId;

/**
 * Standalone tasks (no goal) are reviewed every Nth completion per agent
 * (failures count double). Goal-bound tasks are reviewed together when
 * their goal completes or fails: a task's own "done" is only a claim, so
 * judging what worked has to wait for the goal's real outcome.
 */
const REVIEW_EVERY_N = 4;
/** Reviews are cheap but not free: cap them per day. */
const MAX_REVIEWS_PER_DAY = 24;
/** Transcripts shorter than this hold nothing worth learning. */
const MIN_TRANSCRIPT_CHARS = 600;
/** Safety valve: clear a stuck in-flight review after this long. */
const REVIEW_STUCK_MS = 5 * 60 * 1000;
/** Most tasks folded into one goal review; oldest first when over. */
const MAX_TASKS_PER_GOAL_REVIEW = 6;
/** Combined transcript budget for a goal review's material. */
const GOAL_TRANSCRIPT_BUDGET = 40000;
/** Goal reviews waiting for the in-flight review to finish. */
const MAX_PENDING_GOAL_REVIEWS = 5;

interface TaskCompletedEvent {
  taskId: string;
  agentId: AbjectId;
  agentName?: string;
  goalId?: string | null;
  success: boolean;
  error?: string;
}

interface TranscriptResponse {
  taskId: string;
  agentName: string;
  task: string;
  phase: string;
  steps: number;
  result?: unknown;
  error?: string;
  goalId: string | null;
  injectedKnowledge: Array<{ id: string; title: string }>;
  predictions?: Array<{
    step: number;
    action: string;
    expect: string;
    outcome: 'success' | 'failure';
    missed?: boolean;
    verdict?: 'supported' | 'contradicted' | 'unresolved';
    actualRef?: string;
    actual?: string;
  }>;
  transcript: string;
}

interface ReviewTaskExtra {
  lastResult?: string;
  /** The reviewed tasks to release from AgentAbject once this review ends. */
  reviewedTaskIds?: string[];
  kind: 'review' | 'curation';
  goalId?: string;
}

interface PendingGoalReview {
  goalId: string;
  outcome: 'completed' | 'failed';
  detail?: string;
}

export class TaskReviewer extends Abject {
  private agentAbjectId?: AbjectId;
  private goalManagerId?: AbjectId;
  private knowledgeBaseId?: AbjectId;
  private skillRegistryId?: AbjectId;

  /** Standalone-task counter per agent name; review fires when it crosses REVIEW_EVERY_N. */
  private taskCounters = new Map<string, number>();
  private reviewsToday = 0;
  private reviewsDay = '';

  /** One review or curation at a time; excess completions just tick counters. */
  private inFlight?: { ticketId: string; startedAt: number };
  private taskExtras = new Map<string, ReviewTaskExtra>();
  /** Goal reviews that arrived while a review was in flight. */
  private pendingGoalReviews: PendingGoalReview[] = [];
  private preparingReview = false;
  private reviewPoll?: ReturnType<typeof setInterval>;

  protected override async onStop(): Promise<void> {
    if (this.reviewPoll) clearInterval(this.reviewPoll);
  }

  private async drainDurableReviews(): Promise<void> {
    if (!this.goalManagerId || this.inFlight || this.preparingReview || !this.underDailyCap()) return;
    const pending = await this.request<PendingGoalReview[]>(request(this.id, this.goalManagerId, 'pendingReviews', {}));
    for (const review of pending) {
      await this.onGoalTerminal(review);
      if (this.inFlight) break;
    }
  }

  constructor() {
    super({
      manifest: {
        name: 'TaskReviewer',
        description:
          'Post-task learning loop. Reviews finished agent task transcripts and distills durable lessons into the KnowledgeBase, judges which injected knowledge actually helped, grows the workspace pattern language (pattern entries mined from goal execution records), and packages reusable procedures as skills (installed disabled, pending user approval). Also runs on-demand knowledge curation for the knowledge browser: merging near-duplicate entries and archiving stale ones, fail-closed and never touching user-authored entries.',
        version: '1.0.0',
        interface: {
          id: TASK_REVIEWER_INTERFACE,
          name: 'TaskReviewer',
          description: 'Post-task review and knowledge curation',
          methods: [
            {
              name: 'curate',
              description: 'Start an on-demand curation pass over agent/reviewer-authored knowledge entries: merge near-duplicates into umbrella entries (absorbed entries are archived, restorable) and archive obsolete ones. Returns immediately; results land in the knowledge base as the pass runs.',
              parameters: [],
              returns: { kind: 'object', properties: {
                started: { kind: 'primitive', primitive: 'boolean' },
                message: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'getReviewStatus',
              description: 'Inspect the reviewer: per-agent task counters, reviews run today, and whether a review or curation pass is in flight.',
              parameters: [],
              returns: { kind: 'object', properties: {
                reviewsToday: { kind: 'primitive', primitive: 'number' },
                busy: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
          ],
          events: [
            { name: 'reviewCompleted', description: 'A post-task review finished', payload: { kind: 'object', properties: {} } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'knowledge', 'agent'],
      },
    });

    this.setupHandlers();
  }

  override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.taskCounters instanceof Map, 'taskCounters must be a Map');
    invariant(this.reviewsToday >= 0, 'reviewsToday must be non-negative');
  }

  protected override async onInit(): Promise<void> {
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    // KnowledgeBase/SkillRegistry may register after this object during
    // workspace bootstrap; they resolve lazily on first use (getKbId /
    // getSkillRegistryId), never only at init.

    // Register as an agent so reviews run through the shared OTA loop.
    // canExecute: false keeps the scrum dispatcher from assigning it work;
    // it only ever runs tasks it starts itself.
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'TaskReviewer',
      description: 'Internal post-task reviewer. Reviews finished transcripts to grow the knowledge base; it does not take on user goals.',
      canExecute: false,
      config: {
        snapshotMethod: 'snapshotTask', restoreMethod: 'restoreTask',
        maxSteps: 10,
        timeout: 180000,
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        queueName: `task-reviewer-${this.id}`,
      },
    }));

    // Subscribe to AgentAbject task-lifecycle events (standalone-task
    // cadence) and GoalManager goal-lifecycle events (goal reviews).
    this.send(request(this.id, this.agentAbjectId, 'addDependent', {}));
    if (this.goalManagerId) {
      this.send(request(this.id, this.goalManagerId, 'addDependent', {}));
    }

    this.reviewPoll = setInterval(() => { void this.drainDurableReviews().catch(err => log.warn(String(err))); }, 30000);
    this.reviewPoll.unref?.();
    void this.drainDurableReviews().catch(err => log.warn(String(err)));
    log.info('TaskReviewer registered; reviewing on goal completion + standalone-task cadence');
  }

  protected override askBusyStatus(): string | undefined {
    return this.inFlight ? 'running a review/curation pass' : undefined;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## TaskReviewer
I am the workspace's post-task learning loop. After agents finish tasks, I review their transcripts and save durable lessons to the KnowledgeBase, credit the knowledge entries that helped, and package reusable procedures as skills for the user to approve. The knowledge browser's Curate button asks me to consolidate and tidy the knowledge store on demand.

My work is internal maintenance of this workspace's memory. When invited to contribute to a Sprint Plan, reply PASS.`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('snapshotTask', msg => structuredClone(this.taskExtras.get((msg.payload as { taskId: string }).taskId)));
    this.on('restoreTask', msg => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only AgentAbject may restore task state');
      const { taskId, snapshot } = msg.payload as { taskId: string; snapshot: ReviewTaskExtra };
      if (!snapshot) throw new Error('Missing specialist checkpoint');
      if (this.inFlight && this.inFlight.ticketId !== taskId) throw new Error('Another review is running; retry when it settles');
      this.inFlight = { ticketId: taskId, startedAt: Date.now() };
      this.taskExtras.set(taskId, structuredClone(snapshot));
      return { success: true };
    });

    // Aspect-named event from AgentAbject.changed('taskCompleted', ...).
    // The sender guard matters twice over: it keeps this to the single
    // handler style (not the generic 'changed' one), and GoalManager emits
    // its own 'taskCompleted' aspect which must not tick the counters.
    this.on('taskCompleted', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.agentAbjectId) return;
      const ev = msg.payload as TaskCompletedEvent;
      if (!ev?.taskId || ev.agentId === this.id) return;
      // Goal-bound tasks wait for their goal's outcome; only standalone
      // tasks run on the counter cadence.
      if (ev.goalId) return;
      this.onStandaloneTaskCompleted(ev).catch(err =>
        log.warn(`review trigger failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    // Goal terminal events from GoalManager: the real review moment for
    // everything that ran under the goal.
    this.on('goalCompleted', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.goalManagerId) return;
      const { goalId, result } = msg.payload as { goalId: string; result?: unknown };
      if (!goalId) return;
      this.onGoalTerminal({ goalId, outcome: 'completed', detail: typeof result === 'string' ? result : undefined })
        .catch(err => log.warn(`goal review failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    this.on('goalFailed', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.goalManagerId) return;
      const { goalId, error } = msg.payload as { goalId: string; error?: string };
      if (!goalId) return;
      this.onGoalTerminal({ goalId, outcome: 'failed', detail: error })
        .catch(err => log.warn(`goal review failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    // Terminal result of a review/curation task this object started.
    this.onDelivery('taskResult', async (msg: AbjectMessage) => {
      if(msg.routing.from!==this.agentAbjectId)throw new Error('Task result must come from AgentAbject');
      this.retainTaskResult(msg.payload);
      const { ticketId } = msg.payload as { ticketId: string };
      if (this.inFlight?.ticketId !== ticketId) return;
      const extra = this.taskExtras.get(ticketId);
      const succeeded = (msg.payload as { success?: boolean }).success === true;
      if (succeeded && extra?.goalId && this.goalManagerId) {
        await this.request(request(this.id, this.goalManagerId, 'ackReview', { goalId: extra.goalId }));
      }
      this.inFlight = undefined; this.taskExtras.delete(ticketId);
      for (const taskId of succeeded ? extra?.reviewedTaskIds ?? [] : []) {
        // The transcripts have served their purpose; free them.
        this.send(request(this.id, this.agentAbjectId!, 'releaseTask', { taskId }));
      }
      this.changed('reviewCompleted', { kind: extra?.kind ?? 'review' });

      // Drain a goal review that arrived while this one was running.
      const next = this.pendingGoalReviews.shift();
      if (next) {
        this.onGoalTerminal(next).catch(err =>
          log.warn(`queued goal review failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    // ── Curate button (knowledge browser) ──
    this.on('curate', async () => {
      if (!(await this.getKbId())) {
        return { started: false, message: 'KnowledgeBase not available in this workspace' };
      }
      if (this.inFlight) {
        this.clearStuckReview();
        if (this.inFlight) return { started: false, message: 'A review or curation pass is already running' };
      }
      const started = await this.startCuration();
      return started
        ? { started: true, message: 'Curation pass started; entries update as it runs' }
        : { started: false, message: 'Nothing to curate (no agent/reviewer entries)' };
    });

    this.on('getReviewStatus', async () => ({
      reviewsToday: this.reviewsToday,
      busy: !!this.inFlight || this.preparingReview,
      pending: this.pendingGoalReviews.length,
      counters: Object.fromEntries(this.taskCounters),
    }));

    // ── OTA callbacks ──
    this.on('agentObserve', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      const { taskId } = msg.payload as { taskId: string };
      const extra = this.taskExtras.get(taskId);
      return { observation: extra?.lastResult ?? 'Begin. The material to review is in the conversation above.', tier: 'balanced' };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      const { taskId, action } = msg.payload as { taskId: string; action: AgentAction };
      return this.handleAct(taskId, action);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Review trigger
  // ═══════════════════════════════════════════════════════════════════

  /** Lazy KnowledgeBase discovery: retried on every use until it appears. */
  private async getKbId(): Promise<AbjectId | undefined> {
    if (!this.knowledgeBaseId) {
      this.knowledgeBaseId = await this.discoverDep('KnowledgeBase') ?? undefined;
    }
    return this.knowledgeBaseId;
  }

  /** Ask the actual receiver before relying on learning semantics a replacement may lack. */
  private async requireLearningProtocol(): Promise<void> {
    const description = await this.request<{ manifest: { interface: { methods: Array<{ name: string; parameters: Array<{ name: string }> }> } } }>(
      request(this.id, this.knowledgeBaseId!, 'describe', {}), 10000,
    );
    const methods = description.manifest.interface.methods;
    if (!['recordPatternApplication', 'patternHistory'].every(name => methods.some(m => m.name === name)) ||
        !methods.find(m => m.name === 'update')?.parameters.some(p => p.name === 'expectedRevision') ||
        !methods.find(m => m.name === 'markUseful')?.parameters.some(p => p.name === 'operationId')) {
      throw new Error('KnowledgeBase does not support the learning protocol; upgrade the receiver before recording evidence or revising patterns');
    }
  }

  /** Lazy SkillRegistry discovery: retried on every use until it appears. */
  private async getSkillRegistryId(): Promise<AbjectId | undefined> {
    if (!this.skillRegistryId) {
      this.skillRegistryId = await this.discoverDep('SkillRegistry') ?? undefined;
    }
    return this.skillRegistryId;
  }

  private clearStuckReview(): void {
    if (this.inFlight && Date.now() - this.inFlight.startedAt > REVIEW_STUCK_MS) {
      log.warn(`clearing stuck review ${this.inFlight.ticketId}`);
      // Cancel the zombie loop too; without this "one review in flight"
      // wouldn't actually hold and the stale review could keep writing to
      // the KnowledgeBase alongside the next pass.
      this.send(request(this.id, this.agentAbjectId!, 'cancelTask', { taskId: this.inFlight.ticketId }));
      this.taskExtras.delete(this.inFlight.ticketId);
      this.inFlight = undefined;
    }
  }

  private underDailyCap(): boolean {
    const today = new Date().toDateString();
    if (this.reviewsDay !== today) {
      this.reviewsDay = today;
      this.reviewsToday = 0;
    }
    return this.reviewsToday < MAX_REVIEWS_PER_DAY;
  }

  private async onStandaloneTaskCompleted(ev: TaskCompletedEvent): Promise<void> {
    if (!(await this.getKbId())) return;
    const agentName = ev.agentName ?? 'unknown';
    if (agentName === 'TaskReviewer') return;

    // Failures carry the richest lessons; they count double toward cadence.
    const increment = ev.success ? 1 : 2;
    const count = (this.taskCounters.get(agentName) ?? 0) + increment;
    this.taskCounters.set(agentName, count);
    if (count < REVIEW_EVERY_N) return;

    this.clearStuckReview();
    if (this.inFlight) return;         // keep the counter; review the next one
    if (!this.underDailyCap()) return;

    const record = await this.fetchTranscript(ev.taskId);
    if (!record) return;

    this.taskCounters.set(agentName, 0);

    if (record.transcript.length < MIN_TRANSCRIPT_CHARS) {
      // Nothing to learn from a one-step task; release it and move on.
      this.send(request(this.id, this.agentAbjectId!, 'releaseTask', { taskId: ev.taskId }));
      return;
    }

    const material =
      `## Task under review (standalone, no goal)\n` +
      this.formatTaskSection(record, record.transcript);

    await this.launchReview(
      `Review the finished "${record.agentName}" task and capture durable learnings.`,
      material,
      [record.taskId],
    );
  }

  /**
   * Goal-terminal review: gather every task that ran under the goal and
   * review them together against the goal's REAL outcome, so a task's
   * "done" that led nowhere is read as the dead end it was.
   */
  private async onGoalTerminal(review: PendingGoalReview): Promise<void> {
    if (this.preparingReview) return; // GoalManager retains the durable pending request.
    this.preparingReview = true;
    try { await this.prepareGoalReview(review); } finally { this.preparingReview = false; }
  }

  private async prepareGoalReview(review: PendingGoalReview): Promise<void> {
    if (!(await this.getKbId())) return;
    this.clearStuckReview();
    if (this.inFlight) {
      if (this.pendingGoalReviews.length < MAX_PENDING_GOAL_REVIEWS
          && !this.pendingGoalReviews.some(p => p.goalId === review.goalId)) {
        this.pendingGoalReviews.push(review);
      }
      return;
    }
    if (!this.underDailyCap()) return;

    const goal = await this.request<{ title?: string; description?: string; scratchpad?: Record<string, unknown> } | null>(
      request(this.id, this.goalManagerId!, 'getGoal', { goalId: review.goalId }),
      10000,
    ).catch(() => null);

    // ScrumMaster's execution record (what ran, who ran it, what failed) is
    // the distilled shape of how the goal was actually done: the raw
    // material for pattern mining, richer than the budget-trimmed transcripts.
    const executionRecord = typeof goal?.scratchpad?.['scrum/plan'] === 'string'
      ? (goal.scratchpad['scrum/plan'] as string)
      : undefined;

    // Find this goal's terminal tasks still held by AgentAbject.
    const tasks = await this.request<Array<{ id: string; agentName: string; phase: string; goalId: string | null }>>(
      request(this.id, this.agentAbjectId!, 'listTasks', {}),
      10000,
    ).catch(() => []);
    const goalTaskIds = tasks
      .filter(t => t.goalId === review.goalId
        && t.agentName !== 'TaskReviewer'
        && (t.phase === 'done' || t.phase === 'error'))
      .map(t => t.id)
      .reverse();                       // listTasks is newest-first; review in run order

    const available = new Map<string, TranscriptResponse>();
    for (const [key, value] of Object.entries(goal?.scratchpad ?? {})) {
      if (key.startsWith('learning/task/') && value && typeof value === 'object') {
        const record = value as TranscriptResponse;
        if (record.taskId && record.agentName !== 'TaskReviewer') available.set(record.taskId, record);
      }
    }
    for (const taskId of goalTaskIds) {
      if (available.has(taskId)) continue;
      const record = await this.fetchTranscript(taskId);
      if (record) available.set(taskId, record);
    }
    // Newest recovery/final check first, then surprising/failing episodes.
    const all = [...available.values()].reverse();
    const priority = (r: TranscriptResponse, i: number) => (i === 0 ? 1000 : 0)
      + (r.predictions?.some(p => p.verdict === 'contradicted') ? 100 : 0)
      + (r.phase === 'error' ? 50 : 0) - i;
    const records = all.map((r, i) => ({ r, score: priority(r, i) }))
      .sort((a, b) => b.score - a.score).slice(0, MAX_TASKS_PER_GOAL_REVIEW).map(x => x.r);
    if (records.length === 0) {
      if (this.goalManagerId) await this.request(request(this.id, this.goalManagerId, 'ackReview', { goalId: review.goalId, reason: 'No execution evidence; no pattern claims made' }));
      return;
    }

    const combined = records.reduce((sum, r) => sum + r.transcript.length, 0);
    if (combined < MIN_TRANSCRIPT_CHARS && records.every(r => !r.predictions?.length)) {
      if (this.goalManagerId) await this.request(request(this.id, this.goalManagerId, 'ackReview', { goalId: review.goalId, reason: 'Compact evidence retained; insufficient material for a durable lesson' }));
      for (const id of goalTaskIds) {
        this.send(request(this.id, this.agentAbjectId!, 'releaseTask', { taskId: id }));
      }
      return;
    }

    // Split the transcript budget across tasks, larger tasks trimmed first.
    const perTask = Math.max(6000, Math.floor(GOAL_TRANSCRIPT_BUDGET / records.length));
    let material =
      `## Goal under review\n` +
      `Title: ${goal?.title ?? '(unknown)'}\n` +
      `Description: ${(goal?.description ?? '').slice(0, 1500)}\n` +
      `Outcome: ${review.outcome}${review.detail ? ` (${review.detail.slice(0, 500)})` : ''}\n` +
      `Tasks reviewed: ${records.length}${goalTaskIds.length > records.length ? ` of ${goalTaskIds.length}` : ''}\n`;
    material += `\n### Plan revisions and observations\n${JSON.stringify(Object.fromEntries(Object.entries(goal?.scratchpad ?? {}).filter(([k]) => k === 'learning/plans' || k.startsWith('learning/observation/')))).slice(0, 16000)}\n`;
    material += `\nAll task outcomes (including tasks omitted from detailed transcripts):\n${all.map(r => `${r.taskId}: ${r.agentName}, ${r.phase}, ${r.error ?? ''}`).join('\n')}\n`;
    if (executionRecord) {
      material += `\n### Execution record (ScrumMaster's account of how the goal actually ran)\n${executionRecord.slice(0, 4000)}\n`;
    }
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const transcript = r.transcript.length > perTask
        ? `${r.transcript.slice(0, perTask * 0.65)}\n[... elided ...]\n${r.transcript.slice(-perTask * 0.3)}`
        : r.transcript;
      material += `\n\n## Task ${i + 1} of ${records.length}\n` + this.formatTaskSection(r, transcript);
    }

    await this.launchReview(
      `Review the ${review.outcome} goal "${(goal?.title ?? review.goalId).slice(0, 60)}" and capture durable learnings.`,
      material,
      goalTaskIds,   // durable records retain evidence after transcript release
      review.goalId,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Review / curation task launch
  // ═══════════════════════════════════════════════════════════════════

  private async fetchTranscript(taskId: string): Promise<TranscriptResponse | null> {
    const record = await this.request<TranscriptResponse | null>(
      request(this.id, this.agentAbjectId!, 'getTaskTranscript', { taskId }),
      10000,
    ).catch(() => null);
    return record?.transcript ? record : null;
  }

  /**
   * Render the task's prediction ledger: what the agent said it expected
   * before each action, next to what happened. Divergences are the review's
   * richest ore, so they lead and are labelled; a task where the agent
   * predicted nothing renders nothing rather than an empty heading.
   */
  private formatPredictions(record: TranscriptResponse): string {
    const predictions = record.predictions ?? [];
    if (predictions.length === 0) return '';
    const lines = predictions.map(p => {
      const verdict = p.verdict ?? 'unresolved (legacy action outcome is not a prediction verdict)';
      const actual = p.actual ? `\n  actual: ${(typeof p.actual==='string'?p.actual:JSON.stringify(p.actual)).slice(0, 2000)}` : '';
      return `- step ${p.step} (${p.action}) [${verdict}]\n  expected: ${p.expect}${actual}`;
    });
    return `\n\n### Prediction ledger\n${lines.join('\n')}`;
  }

  private formatTaskSection(record: TranscriptResponse, transcript: string): string {
    const injected = (record.injectedKnowledge ?? []).length > 0
      ? (record.injectedKnowledge ?? []).map(k => `- ${k.id}: ${k.title}`).join('\n')
      : '(none)';
    return (
      `Agent: ${record.agentName}\n` +
      `Task: ${record.task}\n` +
      `Reported outcome: ${record.phase === 'done' ? 'success' : `failure (${record.error ?? 'unknown'})`} after ${record.steps} steps\n\n` +
      `### Knowledge entries injected into this agent's prompt\n${injected}` +
      this.formatPredictions(record) +
      `\n\n### Transcript\n${transcript}`
    );
  }

  private async launchReview(task: string, material: string, reviewedTaskIds: string[], goalId?: string): Promise<void> {
    const taskId = `review-${goalId ?? 'standalone'}-${Date.now()}`;
    this.inFlight = { ticketId: taskId, startedAt: Date.now() };
    this.taskExtras.set(taskId, { kind: 'review', reviewedTaskIds, goalId });
    try {
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId, task,
          systemPrompt: this.reviewSystemPrompt(),
          initialMessages: [{ role: 'user', content: material }],
          config: { maxSteps: 8, timeout: 180000, budgetGoalId: goalId },
        }),
        15000,
      );
      this.reviewsToday++;
      log.info(`Review started: "${task.slice(0, 80)}" over ${reviewedTaskIds.length} task(s) (${this.reviewsToday}/${MAX_REVIEWS_PER_DAY} today)`);
    } catch (err) {
      this.inFlight = undefined; this.taskExtras.delete(taskId);
      log.warn(`launchReview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async startCuration(): Promise<boolean> {
    type Entry = { id: string; title: string; type: string; tags: string[]; origin: string; usefulCount: number; archived: boolean; content: string };
    const all = await this.request<Entry[]>(
      request(this.id, this.knowledgeBaseId!, 'list', { limit: 200 }),
      10000,
    ).catch(() => [] as Entry[]);

    const curatable = all.filter(e => (e.origin === 'agent' || e.origin === 'reviewer') && !e.archived);
    if (curatable.length === 0) return false;

    const listing = curatable
      .map(e => `- ${e.id} [${e.type}] useful:${e.usefulCount} tags:${e.tags.join(',') || '-'}\n  ${e.title}: ${e.content.slice(0, 220)}`)
      .join('\n');

    try {
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          task: 'Curate the knowledge store: merge near-duplicates and archive stale entries.',
          systemPrompt: this.curationSystemPrompt(),
          initialMessages: [{ role: 'user', content: `## Curatable entries (agent/reviewer-authored, active)\n${listing}` }],
          config: { maxSteps: 14, timeout: 300000 },
        }),
        15000,
      );
      this.inFlight = { ticketId, startedAt: Date.now() };
      this.taskExtras.set(ticketId, { kind: 'curation' });
      log.info(`Curation pass started over ${curatable.length} entries`);
      return true;
    } catch (err) {
      log.warn(`startCuration failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════════════════════

  private async handleAct(taskId: string, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const extra = this.taskExtras.get(taskId) ?? { kind: 'review' as const };
    this.taskExtras.set(taskId, extra);

    if (!(await this.getKbId())) {
      return { success: false, error: 'KnowledgeBase not available' };
    }

    try {
      if (['record_pattern_application', 'update_pattern', 'mark_useful'].includes(action.action)) await this.requireLearningProtocol();
      let result: string;
      switch (action.action) {
        case 'recall_knowledge': {
          const query = action.query as string;
          if (!query) return { success: false, error: 'recall_knowledge requires "query"' };
          const hits = await this.request<Array<{ id: string; title: string; type: string; snippet: string }>>(
            request(this.id, this.knowledgeBaseId!, 'recall', { query, limit: 6, previews: true }),
            10000,
          );
          result = hits.length > 0
            ? hits.map(h => `- ${h.id} [${h.type}] ${h.title}: ${h.snippet}`).join('\n')
            : 'No existing entries match.';
          break;
        }

        // Named save_entry, not `remember`: the OTA runtime intercepts a
        // bare `remember` action before it ever reaches this handler and
        // saves WITHOUT the reviewer origin, so a colliding verb name here
        // would silently mislabel every reviewer entry as agent-authored.
        case 'save_entry': {
          const title = action.title as string;
          const content = action.content as string;
          if (!title || !content) return { success: false, error: 'save_entry requires "title" and "content"' };
          const res = await this.request<{ id: string }>(
            request(this.id, this.knowledgeBaseId!, 'remember', {
              title, content,
              type: (action.type as string) ?? 'learned',
              tags: (action.tags as string[]) ?? [],
              origin: 'reviewer',
            }),
            10000,
          );
          result = `Saved "${title}" (${res.id})`;
          break;
        }

        case 'update_entry': {
          const id = action.id as string;
          if (!id) return { success: false, error: 'update_entry requires "id"' };
          const guard = await this.guardCuratable(id, 'update');
          if (guard) return { success: false, error: guard };
          const res = await this.request<{ success: boolean; error?: string }>(
            request(this.id, this.knowledgeBaseId!, 'update', {
              id,
              content: action.content as string | undefined,
              title: action.title as string | undefined,
              tags: action.tags as string[] | undefined,
            }),
            10000,
          );
          if (!res.success) return { success: false, error: res.error ?? 'update failed' };
          result = `Updated ${id}`;
          break;
        }

        case 'forget_entry': {
          const id = action.id as string;
          if (!id) return { success: false, error: 'forget_entry requires "id"' };
          const guard = await this.guardCuratable(id, 'forget');
          if (guard) return { success: false, error: guard };
          await this.request(request(this.id, this.knowledgeBaseId!, 'forget', { id }), 10000);
          result = `Forgot ${id}`;
          break;
        }

        case 'archive_entry': {
          const id = action.id as string;
          if (!id) return { success: false, error: 'archive_entry requires "id"' };
          const guard = await this.guardCuratable(id, 'archive');
          if (guard) return { success: false, error: guard };
          await this.request(request(this.id, this.knowledgeBaseId!, 'archive', { id }), 10000);
          result = `Archived ${id}`;
          break;
        }

        case 'mark_useful': {
          const ids = action.ids as string[];
          if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: 'mark_useful requires non-empty "ids"' };
          const res = await this.request<{ marked: number }>(
            request(this.id, this.knowledgeBaseId!, 'markUseful', { ids, operationId: `review:${[...(this.taskExtras.get(taskId)?.reviewedTaskIds ?? [taskId])].sort().join(',')}` }),
            10000,
          );
          result = `Marked ${res.marked} entries useful`;
          break;
        }

        case 'record_pattern_application': {
          const extra = this.taskExtras.get(taskId);
          const application = action.application as Record<string, unknown>;
          if (!extra?.goalId || !application) return { success: false, error: 'Application evidence requires a goal review and an application object' };
          const res = await this.request<{ success: boolean; error?: string }>(request(this.id, this.knowledgeBaseId!, 'recordPatternApplication', {
            id: action.id, application: { ...application, id: `${extra.goalId}:${action.id}`, goalId: extra.goalId },
          }));
          if (!res.success) return { success: false, error: res.error };
          result = 'Recorded contextual application evidence';
          break;
        }

        case 'save_pattern': {
          result = await this.savePattern(action);
          break;
        }

        case 'update_pattern': {
          result = await this.updatePattern(action);
          break;
        }

        case 'merge_entries': {
          result = await this.mergeEntries(action);
          break;
        }

        case 'author_skill': {
          result = await this.authorSkill(action);
          break;
        }

        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }

      extra.lastResult = result;
      return { success: true, data: result };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      extra.lastResult = `Error: ${errMsg}`;
      return { success: false, error: errMsg };
    }
  }

  /**
   * Refuse destructive/rewrite ops on entries the automated pass must leave
   * alone: only agent/reviewer-authored entries are curatable. User entries
   * belong to the user; scrum entries belong to the scrum process.
   */
  private async guardCuratable(id: string, op: string): Promise<string | undefined> {
    const entry = await this.request<{ origin?: string } | null>(
      request(this.id, this.knowledgeBaseId!, 'get', { id }),
      10000,
    ).catch(() => null);
    if (!entry) return `No entry with id "${id}"`;
    const origin = entry.origin ?? 'agent';
    if (origin !== 'agent' && origin !== 'reviewer') {
      return `Entry ${id} is ${origin}-authored; the reviewer only ${op}s agent/reviewer entries`;
    }
    return undefined;
  }

  /**
   * Add a pattern to the workspace's pattern language.
   *
   * The reviewer supplies named fields and nothing else; the body is built
   * and stored as structure, so there is no format for a caller to get
   * wrong. The title is the pattern's NAME (link resolution is
   * case-insensitive), and remember's title+type dedup means re-saving a
   * name evolves the existing pattern rather than forking it.
   */
  private async savePattern(action: AgentAction): Promise<string> {
    const built = makePattern({
      name: action.name,
      aliases: action.aliases,
      context: action.context,
      problem: action.problem,
      forces: action.forces,
      therefore: action.therefore,
      contract: action.contract,
      program: action.program,
      resultingContext: action.resultingContext,
      consequences: action.consequences,
      appliesTo: action.appliesTo,
      evidence: (action.evidence as string | undefined)?.trim() || 'forming (1 goal)',
      links: action.links,
    });
    if (!built.ok) throw new Error(`save_pattern: ${built.error}`);

    const domainTags = Array.isArray(action.tags)
      ? (action.tags as string[]).filter(t => typeof t === 'string' && t !== 'pattern')
      : [];

    const res = await this.request<{ id: string }>(
      request(this.id, this.knowledgeBaseId!, 'remember', {
        title: built.pattern.name,
        content: serializePattern(built.pattern),
        type: 'pattern',
        tags: ['pattern', ...domainTags],
        origin: 'reviewer',
      }),
      10000,
    );
    return `Saved pattern "${built.pattern.name}" (${res.id})`;
  }

  /**
   * Revise a pattern field by field. Fields the caller omits keep what they
   * held, which is the whole point: an update meaning to refresh one
   * Evidence line must not take the Context, Forces and Therefore with it.
   */
  private async updatePattern(action: AgentAction): Promise<string> {
    const id = action.id as string;
    precondition(!!id, 'update_pattern requires "id"');
    const guard = await this.guardCuratable(id, 'update');
    if (guard) throw new Error(guard);

    const entry = await this.request<{ id: string; title: string; type: string; content: string; pattern?: import('../core/pattern.js').PatternBody } | null>(
      request(this.id, this.knowledgeBaseId!, 'get', { id }),
      10000,
    ).catch(() => null);
    if (!entry) throw new Error(`No entry with id "${id}"`);
    if (entry.type !== 'pattern') {
      throw new Error(`Entry ${id} is type '${entry.type}', not a pattern; use update_entry`);
    }

    const stored = entry.pattern ?? readPattern(entry.content, entry.title);
    if (!stored) throw new Error(`Pattern ${id} ("${entry.title}") could not be read (nothing was changed)`);

    const merged: Record<string, unknown> = { ...stored, name: entry.title };
    for (const field of PATTERN_FIELDS) {
      const value = action[field];
      if (typeof value === 'string' && value.trim()) merged[field] = value.trim();
    }

    const links = [...stored.links];
    const addLinks = Array.isArray(action.addLinks)
      ? (action.addLinks as string[]).map(l => String(l).trim()).filter(l => l.length > 0)
      : [];
    for (const link of addLinks) {
      if (!links.some(l => l.toLowerCase() === link.toLowerCase())) links.push(link);
    }
    merged.links = links;

    const built = makePattern(merged);
    if (!built.ok) throw new Error(`update_pattern: ${built.error} (nothing was changed)`);

    const res = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.knowledgeBaseId!, 'update', {
        id,
        content: serializePattern(built.pattern),
        expectedRevision: stored.learning?.revision ?? 1,
      }),
      10000,
    );
    if (!res.success) throw new Error(res.error ?? 'update failed');
    return `Updated pattern "${entry.title}"`;
  }

  /**
   * Fail-closed umbrella merge: the new entry is written only after every
   * absorbed id is verified to exist and be agent/reviewer-authored; the
   * absorbed entries are archived (restorable), never deleted.
   */
  private async mergeEntries(action: AgentAction): Promise<string> {
    const title = action.title as string;
    const content = action.content as string;
    const absorbedIds = action.absorbedIds as string[];
    precondition(!!title && !!content, 'merge_entries requires "title" and "content"');
    precondition(Array.isArray(absorbedIds) && absorbedIds.length >= 2, 'merge_entries requires "absorbedIds" naming at least 2 entries');

    for (const id of absorbedIds) {
      const entry = await this.request<{ origin?: string; archived?: boolean } | null>(
        request(this.id, this.knowledgeBaseId!, 'get', { id }),
        10000,
      ).catch(() => null);
      if (!entry) throw new Error(`merge aborted: absorbed id "${id}" does not exist (nothing was changed)`);
      const origin = entry.origin ?? 'agent';
      if (origin !== 'agent' && origin !== 'reviewer') {
        throw new Error(`merge aborted: "${id}" is ${origin}-authored, only agent/reviewer entries merge (nothing was changed)`);
      }
    }

    const { id: umbrellaId } = await this.request<{ id: string }>(
      request(this.id, this.knowledgeBaseId!, 'remember', {
        title, content,
        type: (action.type as string) ?? 'learned',
        tags: (action.tags as string[]) ?? [],
        origin: 'reviewer',
      }),
      10000,
    );

    for (const id of absorbedIds) {
      if (id === umbrellaId) continue;   // dedup revived an absorbed entry as the umbrella
      await this.request(request(this.id, this.knowledgeBaseId!, 'archive', { id }), 10000)
        .catch(err => log.warn(`archive of absorbed ${id} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return `Merged ${absorbedIds.length} entries into "${title}" (${umbrellaId}); absorbed entries archived`;
  }

  /**
   * Write a reviewer-authored skill. Containment is structural: reviewer
   * skills live under the "learned-" name prefix, so this path can create
   * or update its own skills and can never touch a bundled or
   * human-installed one. New skills land disabled; the user approves them
   * in Settings before they enter any agent prompt.
   */
  private async authorSkill(action: AgentAction): Promise<string> {
    if (!(await this.getSkillRegistryId())) throw new Error('SkillRegistry not available');
    const rawName = action.name as string;
    const description = action.description as string;
    const instructions = action.instructions as string;
    precondition(!!rawName && !!description && !!instructions, 'author_skill requires "name", "description", and "instructions"');

    let name = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    requireNonEmpty(name, 'skill name after sanitization');
    if (!name.startsWith('learned-')) name = `learned-${name}`;

    // Overwriting an ENABLED skill would put fresh LLM-authored instructions
    // (distilled from transcripts that can contain untrusted web content)
    // straight into every agent's prompt with no re-approval. Disable it
    // first so the update goes back through the user's approval gate.
    const existing = await this.request<{ enabled?: boolean } | null>(
      request(this.id, this.skillRegistryId!, 'getSkill', { name }),
      10000,
    ).catch(() => null);
    const wasEnabled = existing?.enabled === true;
    if (wasEnabled) {
      await this.request(
        request(this.id, this.skillRegistryId!, 'disableSkill', { name }),
        10000,
      );
    }

    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      'origin: reviewer',
      '---',
      '',
      instructions.trim(),
      '',
    ].join('\n');

    await this.request(
      request(this.id, this.skillRegistryId!, 'installSkill', { name, content }),
      15000,
    );
    return wasEnabled
      ? `Updated skill "${name}" and disabled it pending the user's re-approval in Settings`
      : `Authored skill "${name}" (installed disabled; the user can enable it in Settings)`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Prompts
  // ═══════════════════════════════════════════════════════════════════

  private reviewSystemPrompt(): string {
    return `You are a post-task reviewer. Work in this workspace just finished: either a goal (with the transcripts of every task that ran under it, across one or more agents) or a single standalone task. The conversation above contains the material: the outcome, each task's transcript, and the knowledge entries that were injected into each agent's prompt. Your job is to grow the workspace's long-term memory from this experience, then finish. The doing is over; you only distill.

The stated outcome at the top governs your judgment. A task that reported "done" inside a goal that ultimately FAILED is a dead end wearing a success label: mine it for what to avoid, never for "what worked". Approaches earn "what worked" status only when the goal itself succeeded.

## Output Format
Respond with ONE JSON action object inside \`\`\`json fenced code markers. Output ONLY the JSON block; put any brief note in the action's "reasoning" field.

## Actions
| Action | Fields | Purpose |
|--------|--------|---------|
| mark_useful | ids | Credit the injected entries that genuinely influenced the work |
| recall_knowledge | query | Check what the knowledge base already holds before saving |
| save_entry | title, content, type?, tags? | Save one durable lesson (type: 'learned'\|'fact'\|'insight'\|'reference') |
| update_entry | id, content?, title?, tags? | Refresh an existing entry instead of near-duplicating it |
| forget_entry | id | Remove an entry this transcript proves wrong |
| record_pattern_application | id, application | Record context, verdict (applied/helpful/harmful/inconclusive), evidence, and patternRevision for this goal; repeated delivery is deduplicated |
| save_pattern | name, context, forces, therefore, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, links?, tags? | Add a pattern to the workspace's pattern language |
| update_pattern | id, context?, forces?, therefore?, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, addLinks? | Strengthen an existing pattern; only the sections you supply change |
| author_skill | name, description, instructions | Package a reusable multi-step procedure as a skill |
| done | result | Finish with a one-line summary of what you recorded |
| fail | reason | The material was unreviewable |

## How to review
1. **Credit first.** Compare the injected knowledge list against the transcript: entries that demonstrably helped the outcome get one mark_useful call with their ids; mere retrieval or use is not benefit. When none were used, skip straight to lessons.
2. **Mine the prediction misses.** A prediction ledger, when present, lists what each agent expected before acting beside what actually happened. A divergence marks the exact moment a working belief about this system turned out to be wrong, which makes it the most reliable lesson source in the whole record: trust it ahead of anything an agent narrated about its own performance. Only structured predictions assessed as contradicted have a mechanical mismatch; a failed action can be the expected result. Legacy missed flags are not proof. Distinguish uncertainty from contradiction; for the rest, judge the expectation against the actual result yourself, since an agent can succeed at an action and still have expected the wrong thing. Save the corrected belief, phrased as what actually holds and what to do with it, rather than the incident that revealed it. When every prediction held, that is evidence the agent's model was sound and there is likely nothing durable to save.
3. **Distill sparingly.** Most tasks teach nothing durable; finishing with done and "no learnings" is a good review. Save a lesson only when it will help a FUTURE, UNRELATED task: a capability that was hard to locate, an approach that beat the obvious one (with the reason), a constraint that was invisible up front, or a user fact the task confirmed (tag user facts "profile").
4. **Recall before saving.** Search with recall_knowledge first; when a close entry exists, update_entry it rather than adding a sibling.
5. **Record capabilities, skip grievances.** Write what worked and what things are for. Leave transient failures (timeouts, one-off errors, flaky runs) unrecorded: a "this tool is broken" entry outlives the outage and talks future agents out of a working tool. Record a limitation only when the transcript proves it is permanent and structural, and phrase it as what to do instead.
6. **Procedures become skills.** When the transcript shows a reusable multi-step procedure that took real effort to get right (3+ steps, especially after retries), author_skill it. Skills are shared beyond this workspace, so keep them fully generic: the procedure, its steps, its pitfalls. Every personal or workspace-specific detail (names, addresses, accounts, file paths) belongs in save_entry, never in a skill.
7. **Scratchpad material stays out.** Goal-specific findings, intermediate data, and in-progress state already live on the goal's scratchpad; the knowledge base is only for lessons that outlive the goal.

## Grow the pattern language
The workspace's memory includes a generative pattern language in the Alexander/Coplien tradition: write patterns the way Christopher Alexander and James Coplien do, where each pattern names a recurring context, lays out forces genuinely in tension, and resolves them, and the patterns link into a language that generates good solutions piecemeal. The anatomy of an entry of type 'pattern' is Context (when the pattern applies), Forces (the tensions that make the naive approach fail), Therefore (the resolution of those forces, not a mere tip), optional Contract (checkable obligations), optional Program (a worked example), Resulting context (what holds afterwards, and which patterns apply next), Evidence (how proven it is, Alexander's confidence stars in prose), and Links to related patterns. Goal reviews may include the goal's execution record; that record is your ore for pattern mining.

- **Weave before writing.** recall_knowledge with the goal's context terms surfaces existing patterns and 'candidate-pattern'-tagged lessons. When an existing pattern's context covers this goal, update_pattern it: refine its Forces with what this goal revealed, refresh its Evidence line (for example "proven in 3 goals"), and addLinks to related patterns.
- **Record applications.** For patterns actually used, record_pattern_application with the observed context, evidence, patternRevision, and a verdict. Distinguish following a pattern from benefiting; include counterexamples and competing causes.
- **Patterns are earned.** A shape seen once becomes a save_entry lesson tagged 'candidate-pattern'. Promote it with save_pattern when the shape recurs; the recall step surfaces the candidate. Most goals teach no pattern, and a language that grows slowly stays trustworthy.
- **Generalize.** A pattern names a recurring CONTEXT, never this goal: keep goal titles and agent names out. Name patterns as short capitalized noun phrases (like DATA THEN JUDGMENT), and let the name be evocative enough to use in conversation.
- **Failed goals teach too.** When a followed pattern contributed to failure, record the counterexample and refine its Context or Forces. Consider alternative causes: a transient outage does not refute a design pattern. Preserve inconclusive cases as uncertain.
- **Link the language.** Patterns gain power from their links. When a new pattern completes, refines, or sets up another, name it in links; a link to a pattern nobody has written yet marks work for a future review.

Work in at most a handful of actions, then done.`;
  }

  private curationSystemPrompt(): string {
    return `You are curating this workspace's knowledge store at the user's request. The conversation above lists every active agent/reviewer-authored entry (user-authored entries are excluded and protected). Consolidate and tidy, then finish.

## Output Format
Respond with ONE JSON action object inside \`\`\`json fenced code markers. Output ONLY the JSON block; put any brief note in the action's "reasoning" field.

## Actions
| Action | Fields | Purpose |
|--------|--------|---------|
| recall_knowledge | query | Inspect entries on a topic more closely |
| merge_entries | title, content, type?, tags?, absorbedIds | Replace 2+ narrow near-duplicates with one umbrella entry; the absorbed entries are archived (restorable) |
| update_entry | id, content?, title?, tags? | Sharpen a single entry's wording or tags |
| record_pattern_application | id, application | Record context, verdict (applied/helpful/harmful/inconclusive), evidence, and patternRevision for this goal; repeated delivery is deduplicated |
| save_pattern | name, context, forces, therefore, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, links?, tags? | Write a pattern (e.g. promote ripe candidate-pattern lessons, or fulfill a dangling link) |
| update_pattern | id, context?, forces?, therefore?, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, addLinks? | Revise a pattern's sections or extend its links |
| archive_entry | id | Archive an entry that is stale or too narrow to help future tasks |
| forget_entry | id | Delete an entry that is factually wrong |
| done | result | Finish with a one-line summary of the pass |

## How to curate
- **Merge by topic, keep the substance.** When several entries cover one theme (e.g. three lessons about the same tool), write one umbrella entry that preserves every distinct fact, and list ALL of their ids in absorbedIds. The merge is fail-closed: it applies only when every absorbed id checks out, so list them precisely.
- **Archive, keep delete for falsehoods.** archive_entry hides an entry but keeps it restorable in the browser; forget_entry is only for entries that are wrong.
- **Entries with useful counts have proven themselves**: prefer merging them INTO umbrellas over archiving them away.
- **Garden the pattern language.** Entries of type 'pattern' are Alexander/Coplien-style patterns: Context/Forces/Therefore anatomy with links to related patterns, forming a generative language rather than a list of tips. Merge patterns whose contexts have converged into one (merge_entries, then update_pattern the survivor's links); update_pattern one whose context has drifted or split; repair links that name a retitled pattern; and when a dangling link's territory is covered by ripe candidate-pattern lessons, write the missing pattern with save_pattern. A connected language beats a bag of isolated aphorisms.
- **A light pass is a good pass.** When the store is already tidy, finish early with done; changing little is the expected outcome.

Work in at most a handful of actions, then done.`;
  }
}

export const TASK_REVIEWER_ID = 'abjects:task-reviewer' as AbjectId;
