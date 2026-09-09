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
import type { AgentAction, PredictionRecord } from './agent-abject.js';
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
  predictions?: PredictionRecord[];
  transcript: string;
}

interface LearningUpdate {
  key: string;
  action: AgentAction;
  status: 'saved' | 'rejected' | 'unresolved';
  result?: unknown;
  error?: string;
}

interface ReviewTaskExtra {
  updates?: LearningUpdate[];
  assessments?: Record<string, { verdict: string; explanation?: string }>;
  applicationAssessments?: Record<string, string>;
  lastResult?: string;
  /** The reviewed tasks to release from AgentAbject once this review ends. */
  reviewedTaskIds?: string[];
  kind: 'review' | 'curation';
  records?: TranscriptResponse[];
  fullMaterial?: string;
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
        snapshotMethod: 'snapshotTask', restoreMethod: 'restoreTask', completionMethod: 'completeReview',
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
    this.on('completeReview', async msg => {
      await this.requireTaskRuntime(msg, this.agentAbjectId);
      const extra = this.taskExtras.get((msg.payload as { taskId: string }).taskId);
      // Settlement reports uncertainty; it never forces another LLM turn merely
      // to satisfy learning bookkeeping.
      const report = this.learningReport(extra);
      return { accepted: true, result: report, evidence: report };
    });
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
      if (error === 'Stopped by user') return;
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
      if (extra?.goalId && this.goalManagerId) {
        await this.request(request(this.id, this.goalManagerId, 'ackReview', { goalId: extra.goalId, report: this.learningReport(extra, !succeeded) }));
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
      return { observation: extra?.lastResult ? 'The last action result is already in the conversation. Continue evaluating predictions, pattern applications and evidence.' : 'Begin. The learning dossier and prefetched knowledge are in the conversation above.', tier: 'balanced' };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      const { taskId, action } = msg.payload as { taskId: string; action: AgentAction };
      let result: { success: boolean; data?: unknown; error?: string };
      try { result = await this.handleAct(taskId, action); }
      catch (err) { result = { success: false, error: err instanceof Error ? err.message : String(err) }; }
      const extra = this.taskExtras.get(taskId);
      if (extra && ['assess_prediction', 'record_pattern_application', 'save_entry', 'update_entry', 'archive_entry', 'forget_entry', 'mark_useful', 'save_pattern', 'update_pattern', 'merge_entries', 'author_skill'].includes(action.action)) {
        const app = action.application as Record<string, unknown> | undefined;
        const key = JSON.stringify([action.action, action.id ?? action.title ?? action.name ?? action.ids ?? '', action.taskId ?? app?.taskId ?? '', action.step ?? app?.step ?? '']);
        const updates = extra.updates ??= [];
        const update: LearningUpdate = { key, action: structuredClone(action), status: result.success ? 'saved' : /unresolved|provenance|reference/i.test(result.error ?? '') ? 'unresolved' : 'rejected', result: result.data, error: result.error };
        updates.push(update);
        return { ...result, learningStatus: update.status };
      }
      return result;
    });
  }

  private learningReport(extra?: ReviewTaskExtra, interrupted = false) {
    const updates = extra?.updates ?? [];
    const assessments = extra?.assessments ?? {};
    const episodes = new Map<string, PredictionRecord>((extra?.records ?? []).flatMap(r => (r.predictions ?? []).map(p => [`${r.taskId}:${p.step}`, p] as const)));
    const unassessed = [...episodes].filter(([key]) => !assessments[key]).map(([key]) => key);
    const counts = { supported: 0, contradicted: 0, unresolved: unassessed.length };
    for (const [key, a] of Object.entries(assessments)) if (episodes.has(key) && a.verdict in counts) counts[a.verdict as keyof typeof counts]++;
    const latest = new Map(updates.map(u => [u.key, u]));
    const saved = [...new Map(updates.filter(u => u.status === 'saved').map(u => [u.key, u])).values()];
    const pending = [...latest.values()].filter(u => u.status !== 'saved');
    const patternCounts = { helpful: 0, harmful: 0, inconclusive: 0, unresolved: 0 };
    const unassessedApplications: Array<{ taskId: string; step: number; id: string; applicationRef?: string }> = [];
    for (const r of extra?.records ?? []) for (const p of r.predictions ?? []) for (const applied of p.patterns ?? []) {
      const verdict = extra?.applicationAssessments?.[`${r.taskId}:${p.step}:${applied.id}`];
      if (verdict === 'helpful' || verdict === 'harmful' || verdict === 'inconclusive') patternCounts[verdict]++;
      else { patternCounts.unresolved++; unassessedApplications.push({ taskId: r.taskId, step: p.step, id: applied.id, applicationRef: applied.applicationRef }); }
    }
    const status = interrupted || pending.length || counts.unresolved || patternCounts.unresolved ? 'partial' : 'complete';
    return { status, interrupted, saved, pending, attempts: updates,
      predictions: { total: episodes.size, ...counts, unassessed },
      patterns: { ...patternCounts, unassessed: unassessedApplications },
      summary: `Learning review ${status}: ${saved.length} updates saved, ${pending.length} pending. Predictions: ${counts.supported} supported, ${counts.contradicted} contradicted, ${counts.unresolved} unresolved. Pattern applications: ${patternCounts.helpful} helpful, ${patternCounts.harmful} harmful, ${patternCounts.inconclusive} inconclusive, ${patternCounts.unresolved} unassessed.` };
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
      [record.taskId], undefined, [record],
    );
  }

  /**
   * Goal-terminal review: gather every task that ran under the goal and
   * review them together against the goal's REAL outcome, so a task's
   * "done" that led nowhere is read as the dead end it was.
   */
  private async onGoalTerminal(review: PendingGoalReview): Promise<void> {
    if (review.detail === 'Stopped by user') {
      // Older checkpoints may still have this review pending; settle it without another model call.
      if (this.goalManagerId) await this.request(request(this.id, this.goalManagerId, 'ackReview', { goalId: review.goalId }));
      return;
    }
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
      review.goalId, all,
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
   * richest ore, so they lead and are labelled. Episodes without a stated
   * prediction are explicit unknowns rather than implied confirmations.
   */
  private formatPredictions(record: TranscriptResponse): string {
    const predictions = [...(record.predictions ?? [])].sort((a, b) => Number(b.verdict === 'contradicted') - Number(a.verdict === 'contradicted'));
    if (predictions.length === 0) return '';
    const lines = predictions.map(p => {
      const verdict = p.verdict ?? 'unresolved (legacy action outcome is not a prediction verdict)';
      const actual = p.actual ? `\n  observed: ${(typeof p.actual==='string'?p.actual:JSON.stringify(p.actual)).slice(0, 500)}` : '';
      return `- step ${p.step} (${p.action}) [${verdict}; operation status only; semantic prediction unresolved]\n  expected: ${p.expect || '(not stated — unknown)'}; predictedAt=${p.predictedAt ?? 'unknown'}, observedAt=${p.observedAt ?? 'unknown'}\n  applied patterns (agent declaration): ${JSON.stringify(p.patterns ?? [])}${actual}\n  evidence: read_evidence taskId=${record.taskId}, step=${p.step}`;
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

  /** Budget the whole dossier; full records remain addressable through this receiver. */
  private async buildLearningDossier(task: string, material: string, records: TranscriptResponse[]): Promise<string> {
    const pieces: string[] = [];
    let remaining = GOAL_TRANSCRIPT_BUDGET;
    const append = (text: string, cap: number): void => {
      const limit = Math.min(cap, remaining);
      if (limit <= 0) return;
      const part = text.length > limit ? `${text.slice(0, Math.max(0, limit - 100))}\n[Briefing excerpt; use read_evidence for complete material.]` : text;
      pieces.push(part); remaining -= part.length + 2;
    };
    append(`Learning dossier: ${records.length} task records. Task success is not prediction accuracy. Missing predictions are unknown, not confirmations.\nUse read_evidence with taskId and optional step for observations, key for learning/plans or learning/observation/<operationId>, or offset/length for complete material.`, 1000);
    append(records.map(r => `${r.taskId}: ${r.agentName}, outcome=${r.phase}; ${r.predictions?.length ?? 0} observations, ${r.predictions?.filter(p => p.verdict === 'contradicted').length ?? 0} operation contradictions`).join('\n'), 4000);
    // Index surprises across ALL tasks, including tasks omitted from transcript excerpts.
    const predictions = records.flatMap(r => (r.predictions ?? []).map(p => ({ r, p })));
    predictions.sort((a, b) => Number(b.p.verdict === 'contradicted') - Number(a.p.verdict === 'contradicted'));
    append(`Prediction/feedback index (${predictions.length} observations):\n` + predictions.map(({ r, p }) =>
      `${r.taskId} step ${p.step}: operation=${p.outcome}, status comparison=${p.verdict ?? 'unresolved'}, semantic=unresolved; expected=${p.expect || '(missing)'}; patterns=${JSON.stringify(p.patterns ?? [])}`).join('\n'), 10000);
    const kb = await this.getKbId();
    if (kb) {
      const recalled = await this.request<Array<{ id: string; title: string; snippet?: string }>>(request(this.id, kb, 'recall', { query: task, limit: 6, previews: true })).catch(() => []);
      const ids = [...new Set([...predictions.flatMap(({ p }) => (p.patterns ?? []).map(p => p.id)), ...records.flatMap(r => (r.injectedKnowledge ?? []).map(k => k.id)), ...recalled.map(k => k.id)])].slice(0, 12);
      const entries = await Promise.all(ids.map(id => this.request(request(this.id, kb, 'get', { id })).catch(() => null)));
      append('Prefetched existing knowledge (injection is not evidence of application; current revision may differ from the applied revision):\n' + entries.filter(Boolean).map(e => JSON.stringify(e)).join('\n'), 9000);
    }
    // After the evidence index and existing model, spend the remainder on execution context.
    append(material, remaining);
    return pieces.join('\n\n');
  }

  private async launchReview(task: string, material: string, reviewedTaskIds: string[], goalId?: string, records: TranscriptResponse[] = []): Promise<void> {
    const taskId = `review-${goalId ?? 'standalone'}-${Date.now()}`;
    this.inFlight = { ticketId: taskId, startedAt: Date.now() };
    this.taskExtras.set(taskId, { kind: 'review', reviewedTaskIds, goalId, records, fullMaterial: material });
    const dossier = await this.buildLearningDossier(task, material, records);
    try {
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId, task,
          systemPrompt: this.reviewSystemPrompt(),
          initialMessages: [{ role: 'user', content: dossier }],
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
        case 'assess_prediction': {
          if (!extra.goalId || !this.goalManagerId) throw new Error('A goal review is required to record an assessment');
          if (!extra.records?.some(r => r.taskId === action.taskId && r.predictions?.some(p => p.step === action.step))) throw new Error('Assessment is outside this review evidence');
          const decision = await this.request<{ success: boolean; error?: string; assessment?: { verdict: string; explanation?: string } }>(request(this.id, this.goalManagerId, 'recordPredictionAssessment', {
            goalId: extra.goalId, taskId: action.taskId, step: action.step, verdict: action.verdict, explanation: action.explanation,
          }));
          if (!decision.success) throw new Error(decision.error ?? 'Assessment rejected');
          if (decision.assessment) (extra.assessments ??= {})[`${action.taskId}:${action.step}`] = decision.assessment;
          result = JSON.stringify(decision);
          break;
        }
        case 'read_evidence': {
          let text = extra.fullMaterial ?? '';
          if (typeof action.key === 'string') {
            if (!extra.goalId || !this.goalManagerId || !(action.key === 'learning/plans' || action.key === 'learning/reviewOutcome' || action.key === 'scrum/plan' || action.key.startsWith('learning/observation/') || action.key.startsWith('learning/assessment/'))) throw new Error('Key is outside the review learning evidence');
            text = JSON.stringify(await this.request(request(this.id, this.goalManagerId, 'readGoalData', { goalId: extra.goalId, key: action.key }))) ?? 'null';
          }
          if (typeof action.taskId === 'string') {
            const record = extra.records?.find(r => r.taskId === action.taskId);
            if (!record) throw new Error('Task is outside this review evidence');
            if (typeof action.step === 'number') {
              const prediction = record.predictions?.find(p => p.step === action.step);
              let observed: unknown;
              if (extra.goalId && this.goalManagerId) observed = await this.request(request(this.id, this.goalManagerId, 'readGoalData', {
                goalId: extra.goalId, key: `learning/observation/${record.taskId}:${action.step}`,
              }));
              text = JSON.stringify({ prediction, observed: observed ?? null });
            } else text = JSON.stringify(record);
          }
          const offset = Math.max(0, Number(action.offset) || 0), length = Math.max(1, Math.min(30000, Number(action.length) || 16000));
          result = `${text.slice(offset, offset + length)}\n[${offset}..${Math.min(offset + length, text.length)} of ${text.length}; continue with read_evidence offset/length]`;
          break;
        }
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
          if (!res?.id) throw new Error('KnowledgeBase did not acknowledge the saved entry');
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
          const decision = await this.request<{ success: boolean; error?: string }>(request(this.id, this.knowledgeBaseId!, 'forget', { id }), 10000);
          if (!decision?.success) throw new Error(decision?.error ?? 'forget failed');
          result = `Forgot ${id}`;
          break;
        }

        case 'archive_entry': {
          const id = action.id as string;
          if (!id) return { success: false, error: 'archive_entry requires "id"' };
          const guard = await this.guardCuratable(id, 'archive');
          if (guard) return { success: false, error: guard };
          const decision = await this.request<{ success: boolean; error?: string }>(request(this.id, this.knowledgeBaseId!, 'archive', { id }), 10000);
          if (!decision?.success) throw new Error(decision?.error ?? 'archive failed');
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
          if (!Number.isSafeInteger(res?.marked)) throw new Error('KnowledgeBase did not acknowledge usefulness feedback');
          result = `Marked ${res.marked} entries useful`;
          break;
        }

        case 'record_pattern_application': {
          const extra = this.taskExtras.get(taskId);
          const application = action.application as Record<string, unknown>;
          if (!extra?.goalId || !application) return { success: false, error: 'Application evidence requires a goal review and an application object' };
          const episodes = (extra.records ?? []).flatMap(r => (r.predictions ?? []).flatMap(p =>
            (p.patterns ?? []).filter(a => a.id === action.id && (application.taskId === undefined || (r.taskId === application.taskId && p.step === application.step)))
              .map(applied => ({ taskId: r.taskId, step: p.step, outcome: p.outcome, applied }))));
          if (episodes.length !== 1) throw new Error('Unresolved application: identify one observed taskId and step using read_evidence');
          const { applied, taskId: observedTaskId, step, outcome } = episodes[0];
          if (outcome === 'unknown' && application.verdict !== 'inconclusive') throw new Error('Unobserved application effects remain inconclusive');
          let res: { success: boolean; error?: string };
          if (applied.applicationRef) {
            res = await this.request(request(this.id, this.knowledgeBaseId!, 'assessPatternApplication', {
              id: action.id, applicationRef: applied.applicationRef, goalId: extra.goalId,
              verdict: application.verdict, evidence: application.evidence,
            }));
          } else if (Number.isSafeInteger(applied.revision) && applied.revision! > 0) {
            // Historical evidence can contain an explicit captured revision.
            // Never substitute today's revision for missing provenance.
            res = await this.request(request(this.id, this.knowledgeBaseId!, 'recordPatternApplication', {
              id: action.id, application: { id: `${extra.goalId}:${action.id}:${observedTaskId}:${step}`, goalId: extra.goalId,
                context: application.context, evidence: application.evidence, verdict: application.verdict, patternRevision: applied.revision },
            }));
          } else throw new Error('Unresolved application provenance; retain this evidence for a later review, without guessing a revision');
          if (!res.success) return { success: false, error: res.error };
          (extra.applicationAssessments ??= {})[`${observedTaskId}:${step}:${action.id}`] = String(application.verdict);
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
    if (!res?.id) throw new Error('KnowledgeBase did not acknowledge the saved pattern');
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

    if (!umbrellaId) throw new Error('KnowledgeBase did not acknowledge the merged entry');
    const failures: string[] = [];
    for (const id of absorbedIds) {
      if (id === umbrellaId) continue;   // dedup revived an absorbed entry as the umbrella
      try {
        const decision = await this.request<{ success: boolean; error?: string }>(request(this.id, this.knowledgeBaseId!, 'archive', { id }), 10000);
        if (!decision?.success) throw new Error(decision?.error ?? 'archive rejected');
      } catch (err) { failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (failures.length) throw new Error(`Merged content saved as ${umbrellaId}; pending archives: ${failures.join('; ')}`);
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
| assess_prediction | taskId, step, verdict, explanation | Record supported/contradicted/unresolved semantic assessment with an evidence-grounded explanation, separately from observations |
| read_evidence | taskId?, step?, key?, offset?, length? | Retrieve complete task evidence or a prediction/observation pair from this review |
| recall_knowledge | query | Check what the knowledge base already holds before saving |
| save_entry | title, content, type?, tags? | Save one durable lesson (type: 'learned'\|'fact'\|'insight'\|'reference') |
| update_entry | id, content?, title?, tags? | Refresh an existing entry instead of near-duplicating it |
| forget_entry | id | Remove an entry this transcript proves wrong |
| record_pattern_application | id, application | Record context, verdict (applied/helpful/harmful/inconclusive), evidence, and taskId/step for this goal; the runtime resolves the applied version; repeated delivery is deduplicated |
| save_pattern | name, context, forces, therefore, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, links?, tags? | Add a pattern to the workspace's pattern language |
| update_pattern | id, context?, forces?, therefore?, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, addLinks? | Strengthen an existing pattern; only the sections you supply change |
| author_skill | name, description, instructions | Package a reusable multi-step procedure as a skill |
| done | result | Finish with a one-line summary of what you recorded |
| fail | reason | The material was unreviewable |

## How to review
1. **Credit first.** Compare the injected knowledge list against the transcript: entries that demonstrably helped the outcome get one mark_useful call with their ids; mere retrieval or use is not benefit. When none were used, skip straight to lessons.
2. **Mine the prediction misses.** A prediction ledger, when present, lists what each agent expected before acting beside what actually happened. A divergence marks the exact moment a working belief about this system turned out to be wrong, which makes it the most reliable lesson source in the whole record: trust it ahead of anything an agent narrated about its own performance. Only structured predictions assessed as contradicted have a mechanical mismatch; a failed action can be the expected result. Legacy missed flags are not proof. Distinguish uncertainty from contradiction; for the rest, judge the expectation against the actual result yourself, since an agent can succeed at an action and still have expected the wrong thing. Save the corrected belief, phrased as what actually holds and what to do with it, rather than the incident that revealed it. Record semantic assessments with assess_prediction. Successful actions alone do not establish that predictions held.
3. **Distill sparingly.** Most tasks teach nothing durable; finishing with done and "no learnings" is a good review. Save a lesson only when it will help a FUTURE, UNRELATED task: a capability that was hard to locate, an approach that beat the obvious one (with the reason), a constraint that was invisible up front, or a user fact the task confirmed (tag user facts "profile").
4. **Consult existing knowledge before saving.** Prefetched entries satisfy recall for the entries shown. Use recall_knowledge or the runtime recall-by-id action when additional context is needed; when a close entry exists, update_entry it rather than adding a sibling.
5. **Preserve evidence without overstating conclusions.** Expected failures, transient outages, and recoveries can test the world model. Record relevant contextual evidence and competing explanations in pattern applications. Do not turn a single timeout into a permanent claim that a capability is broken; keep uncertainty explicit and propose discriminating observations when the cause is unknown.
6. **Procedures become skills.** When the transcript shows a reusable multi-step procedure that took real effort to get right (3+ steps, especially after retries), author_skill it. Skills are shared beyond this workspace, so keep them fully generic: the procedure, its steps, its pitfalls. Every personal or workspace-specific detail (names, addresses, accounts, file paths) belongs in save_entry, never in a skill.
7. **Scratchpad material stays out.** Goal-specific findings, intermediate data, and in-progress state already live on the goal's scratchpad; the knowledge base is only for lessons that outlive the goal.

## Grow the pattern language
The workspace's memory includes a generative pattern language in the Alexander/Coplien tradition: write patterns the way Christopher Alexander and James Coplien do, where each pattern names a recurring context, lays out forces genuinely in tension, and resolves them, and the patterns link into a language that generates good solutions piecemeal. The anatomy of an entry of type 'pattern' is Context (when the pattern applies), Forces (the tensions that make the naive approach fail), Therefore (the resolution of those forces, not a mere tip), optional Contract (checkable obligations), optional Program (a worked example), Resulting context (what holds afterwards, and which patterns apply next), Evidence (how proven it is, Alexander's confidence stars in prose), and Links to related patterns. Goal reviews may include the goal's execution record; that record is your ore for pattern mining.

- **Weave before writing.** recall_knowledge with the goal's context terms surfaces existing patterns and 'candidate-pattern'-tagged lessons. When an existing pattern's context covers this goal, update_pattern it: refine its Forces with what this goal revealed, refresh its Evidence line (for example "proven in 3 goals"), and addLinks to related patterns.
- **Record applications.** For patterns actually used, record_pattern_application with the observed context, evidence, taskId, step, and a verdict. Distinguish following a pattern from benefiting; include counterexamples and competing causes.
- **Patterns are earned.** A shape seen once becomes a save_entry lesson tagged 'candidate-pattern'. Promote it with save_pattern when the shape recurs; the recall step surfaces the candidate. Most goals teach no pattern, and a language that grows slowly stays trustworthy.
- **Generalize.** A pattern names a recurring CONTEXT, never this goal: keep goal titles and agent names out. Name patterns as short capitalized noun phrases (like DATA THEN JUDGMENT), and let the name be evocative enough to use in conversation.
- **Failed goals teach too.** When a followed pattern contributed to failure, record the counterexample and refine its Context or Forces. Consider alternative causes: a transient outage does not refute a design pattern. Preserve inconclusive cases as uncertain.
- **Link the language.** Patterns gain power from their links. When a new pattern completes, refines, or sets up another, name it in links; a link to a pattern nobody has written yet marks work for a future review.

The knowledge base is a world model. Compare predictions made before actions with feedback from the world. A successful task can contain false predictions; an expected rejection can support a narrow operation expectation. Runtime verdicts compare operation status only, not the meaning of a free-text prediction. Use assess_prediction to record material semantic confirmations, contradictions, or unresolved expectations with an evidence-grounded explanation. Review semantic agreement from the evidence, preserve uncertainty, and distinguish observations from agent explanations. Missing predictions remain unknown.

Assess patterns actually applied (id, applied revision, reason), not merely injected knowledge. Record helpful, harmful, and inconclusive applications with evidence and competing explanations. When a pattern was used several times, name taskId and step in each application so distinct episodes survive replay deduplication. Revision numbers are managed automatically. Do not supply them. If provenance is unresolved, inspect read_evidence once; retain unresolved evidence and finish a partial review if it cannot be recovered. Inspect read_evidence when a briefing excerpt is insufficient; preserve contradictions even when the overall goal succeeded. Develop candidate patterns from new explanations and strengthen them only with recurring evidence. Learn from transient failures without turning a single outage into a permanent limitation.

Finish when the evidence supports the learning updates; do not invent an update just to make one.`;
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
| record_pattern_application | id, application | Record context, verdict (applied/helpful/harmful/inconclusive), evidence, and taskId/step for this goal; the runtime resolves the applied version; repeated delivery is deduplicated |
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

The knowledge base is a world model. Compare predictions made before actions with feedback from the world. A successful task can contain false predictions; an expected rejection can support a narrow operation expectation. Runtime verdicts compare operation status only, not the meaning of a free-text prediction. Use assess_prediction to record material semantic confirmations, contradictions, or unresolved expectations with an evidence-grounded explanation. Review semantic agreement from the evidence, preserve uncertainty, and distinguish observations from agent explanations. Missing predictions remain unknown.

Assess patterns actually applied (id, applied revision, reason), not merely injected knowledge. Record helpful, harmful, and inconclusive applications with evidence and competing explanations. When a pattern was used several times, name taskId and step in each application so distinct episodes survive replay deduplication. Revision numbers are managed automatically. Do not supply them. If provenance is unresolved, inspect read_evidence once; retain unresolved evidence and finish a partial review if it cannot be recovered. Inspect read_evidence when a briefing excerpt is insufficient; preserve contradictions even when the overall goal succeeded. Develop candidate patterns from new explanations and strengthen them only with recurring evidence. Learn from transient failures without turning a single outage into a permanent limitation.

Finish when the evidence supports the learning updates; do not invent an update just to make one.`;
  }
}

export const TASK_REVIEWER_ID = 'abjects:task-reviewer' as AbjectId;
