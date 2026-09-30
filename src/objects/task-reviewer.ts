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
import { verificationRecordOf, renderVerificationRecord, type VerificationRecordEntry } from './scrum-master.js';
import { learningFingerprint, validateLearningEffect, type LearningDecision, type LearningEffect } from '../core/learning.js';
import { boundDecisionState, choiceOf, noulOf, scoreOf, topLevel, type DecisionQuestion } from '../llm/decision.js';
import type { DecisionMode } from '../core/decision-sites.js';
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

// Decision-model thresholds (sites reviewer.*; see src/core/decision-sites.ts).
/** reviewer.worth (act): a routine verdict this sure settles a review without the model pass... */
const ROUTINE_MIN_P = 0.85;
/** ...provided owner evidence is this unlikely to contradict injected knowledge. */
const ROUTINE_MAX_CONFLICT = 0.2;
/** reviewer.worth (act): the day's last review slots wait for reviews judged valuable. */
const RESERVED_REVIEW_SLOTS = 6;
/** Worth verdicts kept per goal, so a deferred review is not judged again on every drain. */
const WORTH_CACHE_MAX = 50;
/** reviewer.predictions (act): below this, an automated assessment records unresolved. */
const AUTO_ASSESS_MIN_P = 0.9;
/** Episodes judged in one reviewer.predictions request. */
const MAX_JUDGED_EPISODES = 48;
/** reviewer.fidelity (act): a verdict this sure fills a missing summaryFidelity. */
const AUTO_FIDELITY_MIN_P = 0.8;
/** reviewer.patterns (act): a verdict this sure fills an unassessed application. */
const AUTO_PATTERN_MIN_P = 0.85;
/** Pattern applications judged in one reviewer.patterns request; filled per completion. */
const MAX_JUDGED_APPLICATIONS = 24;
const MAX_FILLED_APPLICATIONS = 12;
/** reviewer.privacy (advise): a leak costs more than a false alarm, so warn early. */
const PRIVACY_WARN_P = 0.5;
/** reviewer.dedupe (act): a relation this sure turns a new entry away. */
const DEDUPE_ACT_P = 0.85;

interface TaskCompletedEvent {
  taskId: string;
  agentId: AbjectId;
  agentName?: string;
  goalId?: string | null;
  success: boolean;
  error?: string;
}

interface TranscriptResponse {
  knowledgeScope?: string;
  knowledgeScopes?: string[];
  taskId: string;
  agentName: string;
  task: string;
  phase: string;
  steps: number;
  result?: unknown;
  error?: string;
  goalId: string | null;
  injectedKnowledge: Array<{ id: string; title: string; source?: 'profile' | 'relevant' | 'pattern'; content?: string; knowledgeRef?: string }>;
  predictions?: PredictionRecord[];
  transcript: string;
}

interface LearningUpdate {
  key: string;
  action: AgentAction;
  /** 'duplicate': turned away because the knowledge base already holds it; nothing is pending. */
  status: 'saved' | 'rejected' | 'unresolved' | 'duplicate';
  result?: unknown;
  error?: string;
}

/** One decision-model judgment, kept on the review for priors and automated records. */
interface Judgment {
  choice: string;
  /** Probability of `choice`. */
  p: number;
  probabilities: Record<string, number>;
  emulated: boolean;
  /** Settled by a rule, not a model (an unobserved outcome stays inconclusive). */
  deterministic?: boolean;
}

/** Judgments made when a goal review launches (sites reviewer.predictions, reviewer.fidelity, reviewer.patterns). */
interface ReviewJudgments {
  /** Keyed `<taskId>:<step>`. */
  predictions?: { mode: DecisionMode; byEpisode: Record<string, Judgment> };
  fidelity?: { mode: DecisionMode; verdict: 'consistent' | 'misreported' | 'unverifiable'; p: number; staleFigure?: number; caveatDropped?: number; emulated: boolean; deterministic?: boolean };
  /** Keyed `<taskId>:<step>:<patternId>`. */
  patterns?: { mode: DecisionMode; byApplication: Record<string, Judgment> };
}

/** How much a finished goal or task could teach (site reviewer.worth). */
interface WorthVerdict {
  mode: DecisionMode;
  level: number;
  /** Probability of `level`. */
  levelP: number;
  /** Probability of level 0 (routine success). */
  routineP: number;
  /** Probability of level 2 or above. */
  highP: number;
  /** Probability that owner evidence contradicts injected knowledge. */
  conflict: number;
  emulated: boolean;
  /** Deferred while the day's reserved slots wait for valuable reviews. */
  deferred?: boolean;
}

interface ReviewTaskExtra {
  knowledgeScope?: string;
  fullKnowledgeRefs?: Record<string, string>;
  decisions?: LearningDecision[];
  knowledgeRefs?: Record<string, string>;
  repairDecisionId?: string;
  updates?: LearningUpdate[];
  completionCorrectionSent?: boolean;
  cancelled?: boolean;
  completionIssues?: string[];
  /** Set once the goal's summary-fidelity verdict is on record. */
  summaryFidelityRecorded?: boolean;
  /** Decision-model judgments made at launch; priors in the dossier, automated records when a site acts. */
  judgments?: ReviewJudgments;
  /** Set once missing assessments were recorded from the judgments (one pass per review). */
  automatedAssessments?: boolean;
  assessments?: Record<string, { verdict: string; explanation?: string }>;
  applicationAssessments?: Record<string, string>;
  lastResult?: string;
  /** The reviewed tasks to release from AgentAbject once this review ends. */
  reviewedTaskIds?: string[];
  kind: 'review' | 'curation' | 'repair';
  records?: TranscriptResponse[];
  fullMaterial?: string;
  goalId?: string;
}

interface PendingGoalReview {
  goalId: string;
  outcome: 'completed' | 'failed';
  detail?: string;
}

// ── Decision questions (file-local; shared ones live in src/core/decision-questions.ts) ──

const WORTH_LEVELS = [
  'Routine success: predictions evidently supported, no errors, no knowledge conflict',
  'Minor errors, recovered easily',
  'Contradicted predictions, retries, a failed goal, or claims about permissions or access',
  'A misreported summary, or owner evidence contradicting injected knowledge',
];

function worthQuestions(): Record<string, DecisionQuestion> {
  return {
    learning_value: {
      type: 'score',
      instructions: 'How much could a learning review of this finished work teach the workspace? Judge from `goal`, `user_result`, `tasks`, `injected_knowledge` and `verification`.',
      criteria: WORTH_LEVELS,
    },
    knowledge_conflict: {
      type: 'noul',
      instructions: 'Does owner evidence (task outcomes, errors, verification receipts) contradict any claim named in `injected_knowledge`?',
    },
  };
}

/** One choice per episode, in GoalManager's assessment vocabulary. */
function reviewPredictionQuestions(count: number): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {};
  for (let i = 0; i < count; i++) {
    out[`q_${i}`] = {
      type: 'choice',
      instructions: `Before acting, an agent stated \`episodes[${i}].expect\`. Judge its material claims against the observed \`episodes[${i}].actual\`, reading the result by the operation's own semantics: a diff that finds differences or a search with no matches can exit non-zero as an ordinary finding, and exit 0 can still hide skipped or partial work. Judge the prediction, not whether the operation succeeded. \`prior\`, when present, is an earlier automated judgment of the same step; weigh it, and let the evidence decide.`,
      criteria: {
        supported: 'Every material claim in the prediction is borne out by the observed result.',
        contradicted: 'The observed result disproves a material claim in the prediction.',
        unresolved: 'The observation is missing, truncated where it matters, or silent on a material claim, and nothing in it disproves the prediction.',
      },
    };
  }
  return out;
}

function fidelityQuestions(): Record<string, DecisionQuestion> {
  return {
    fidelity: {
      type: 'choice',
      instructions: '`user_result` is what the user was told. `receipts` are the recorded verification runs, newest first; `task_reports` are what each task reported. Judge whether the user-facing result is faithful to that record.',
      criteria: {
        consistent: 'Every test or check figure in `user_result` matches the NEWEST receipt, and the caveats the tasks reported (what they did not cover, run, or verify) survive into it.',
        misreported: 'A figure or claim in `user_result` is contradicted or unsupported by the receipts, or a caveat a task reported was dropped.',
      },
    },
    stale_figure: {
      type: 'noul',
      instructions: 'Does `user_result` quote a test or check figure that matches an older receipt rather than the newest one?',
    },
    caveat_dropped: {
      type: 'noul',
      instructions: 'Did a caveat from `task_reports` (something a task did not cover, run, or verify) disappear from `user_result`?',
    },
  };
}

function patternQuestions(count: number): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {};
  for (let i = 0; i < count; i++) {
    out[`a_${i}`] = {
      type: 'choice',
      instructions: `\`applications[${i}]\` records that an agent followed \`applications[${i}].pattern\` at one step, for the reason in \`why\`. From its \`episode\`, its task outcome and \`goal_outcome\`, what did following the pattern's \`therefore\` do?`,
      criteria: {
        helpful: 'The outcome benefited because the Therefore was followed.',
        harmful: 'Following the Therefore contributed to a failure.',
        inconclusive: 'It was followed, but its benefit or harm cannot be separated from other causes.',
      },
    };
  }
  return out;
}

const DETAIL_KINDS: Record<string, string> = {
  personal_name: 'a person\'s name',
  email_address: 'an email address',
  account_or_id: 'an account name or identifier',
  absolute_path: 'an absolute or home-directory file path',
  host_or_url: 'a specific host, address, or private URL',
  secret_or_token: 'a password, key, or token',
  other_detail: 'another detail specific to this workspace',
};

function privacyQuestions(): Record<string, DecisionQuestion> {
  return {
    workspace_specific_detail: {
      type: 'noul',
      instructions: 'Does `skill` (its name, description, or instructions) carry details specific to one workspace or person: names, email addresses, account ids, absolute file paths, hostnames, or tokens? Generic placeholders such as <user> or ~/project do not count.',
    },
    generic_multistep_procedure: {
      type: 'noul',
      instructions: 'Is `skill` a reusable, generic procedure of several steps that other tasks could follow as written?',
    },
    detail_kind: {
      type: 'choice',
      instructions: 'If `skill` carries a workspace-specific detail, which kind is the most prominent?',
      criteria: Object.fromEntries(Object.keys(DETAIL_KINDS).map(k => [k, `It includes ${DETAIL_KINDS[k]}.`])),
    },
  };
}

const ENTRY_KIND_ADVICE: Record<string, string> = {
  route_procedure: 'save what holds true (what a thing is, what it exposes, what its output means) and leave the route to the task',
  goal_specific_scratchpad: 'the goal scratchpad already keeps goal-specific findings; the knowledge base keeps lessons that outlive the goal',
  user_profile_fact: 'tag user facts "profile"',
};

function dedupeQuestions(count: number): Record<string, DecisionQuestion> {
  const relation: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    relation[`duplicate_of_${i}`] = `Says what \`existing[${i}]\` already says: saving it would add a second copy.`;
    relation[`refines_${i}`] = `Corrects, narrows, or extends \`existing[${i}]\`: that entry could absorb it.`;
  }
  relation.new = 'Covers something none of `existing` holds.';
  return {
    relation: {
      type: 'choice',
      instructions: 'How does `new_entry` relate to the entries already in the knowledge base (`existing`)?',
      criteria: relation,
    },
    entry_kind: {
      type: 'choice',
      instructions: 'What kind of knowledge is `new_entry`?',
      criteria: {
        durable_fact_or_constraint: 'A durable fact about the system, a tool, or a constraint that holds beyond this goal.',
        route_procedure: 'The route one task took (which steps to run for a kind of question) rather than what is true.',
        goal_specific_scratchpad: 'Findings or intermediate data specific to one goal.',
        user_profile_fact: 'A fact about the user: a preference, a detail, or a habit.',
      },
    },
  };
}

/** Text clipped for a decision state or an explanation. */
function clipText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value) ?? '';
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

function fmtP(p: number | undefined): string {
  return p === undefined || !Number.isFinite(p) ? '?' : p.toFixed(2);
}

function judgmentFrom(answer: { choice: string; probabilities: Record<string, number> }, emulated: boolean): Judgment {
  return { choice: answer.choice, p: answer.probabilities[answer.choice] ?? 0, probabilities: answer.probabilities, emulated };
}

/** "decision model, p=0.93" with the emulation noted: the provenance line on every automated record. */
function provenance(j: { p: number; emulated: boolean }): string {
  return `decision model${j.emulated ? ', emulated' : ''}, p=${fmtP(j.p)}`;
}

/** The observed side of an episode in one line: its operation outcome and, when visible, its exit code. */
function observedLine(p: PredictionRecord): string {
  const exit = /"exitCode"\s*:\s*(-?\d+)|exit(?:\s+code)?\s*[:=]?\s*(-?\d+)/i.exec(typeof p.actual === 'string' ? p.actual : '');
  const code = exit ? exit[1] ?? exit[2] : undefined;
  return `outcome=${p.outcome}${code !== undefined ? ` (exit ${code})` : ''}`;
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
  /** Learning-value verdicts per goal (site reviewer.worth), oldest evicted first. */
  private worthByGoal = new Map<string, WorthVerdict>();
  private preparingReview = false;
  private drainingLearning = false;
  private recoveredLegacyReviews = false;
  private reviewPoll?: ReturnType<typeof setInterval>;

  protected override async onStop(): Promise<void> {
    if (this.reviewPoll) clearInterval(this.reviewPoll);
  }

  /**
   * @param recoverLegacy Also recover proposals left by the older learning
   *   model. The initial drain from onInit passes false: the Factory registers
   *   this object in the registry only after init returns, and AgentAbject
   *   gates recovery on finding TaskReviewer there, so an attempt during init
   *   is rejected. The 30 s poll runs after registration and recovers then.
   */
  private async drainDurableReviews(recoverLegacy = true): Promise<void> {
    if (!this.goalManagerId || this.inFlight || this.preparingReview || !this.underDailyCap()) return;
    if (recoverLegacy && !this.recoveredLegacyReviews) await this.recoverLegacyReviews().catch(err => log.warn(`Legacy learning recovery deferred: ${String(err)}`));
    await this.drainLearningDecisions();
    if (this.inFlight) return;
    const pending = await this.request<PendingGoalReview[]>(request(this.id, this.goalManagerId, 'pendingReviews', {}));
    for (const review of this.worthByGoal.size && await this.worthOrdering() ? this.sortByWorth(pending) : pending) {
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
    invariant(this.worthByGoal.size <= WORTH_CACHE_MAX, 'worth verdicts must stay bounded');
  }

  protected override async onInit(): Promise<void> {
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    // KnowledgeBase/SkillRegistry may register after this object during
    // workspace bootstrap; they resolve lazily on first use (getKbId /
    // getSkillRegistryId), never only at init.

    // Register as an agent so reviews run through the shared OTA loop.
    // canExecute: false keeps the scrum dispatcher from assigning it work;
    // it only ever runs tasks it starts itself. joinsPlanning: false keeps
    // planning polls from asking it at all: its answer is always PASS.
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'TaskReviewer',
      description: 'Internal post-task reviewer. Reviews finished transcripts to grow the knowledge base; it does not take on user goals.',
      canExecute: false,
      joinsPlanning: false,
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
    void this.drainDurableReviews(false).catch(err => log.warn(String(err)));
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
    this.on('recordKnowledgeSelection', async msg => {
      await this.requireTaskRuntime(msg, this.agentAbjectId);
      const { taskId, selection } = msg.payload as { taskId: string; selection: { id: string; knowledgeRef?: string; complete?: boolean } };
      const extra = this.taskExtras.get(taskId);
      if (extra && selection.knowledgeRef) (extra.knowledgeRefs ??= {})[selection.id] = selection.knowledgeRef;
      if (extra && selection.knowledgeRef && selection.complete) (extra.fullKnowledgeRefs ??= {})[selection.id] = selection.knowledgeRef;
      return { success: !!extra };
    });
    this.on('completeReview', async msg => {
      await this.requireTaskRuntime(msg, this.agentAbjectId);
      const { taskId, result } = msg.payload as { taskId: string; result?: unknown };
      return this.completeReview(taskId, result);
    });
    this.on('taskCancelled', async msg => {
      await this.requireTaskRuntime(msg, this.agentAbjectId);
      const extra = this.taskExtras.get((msg.payload as { taskId: string }).taskId);
      if (extra) extra.cancelled = true;
      return { success: true };
    });
    this.on('snapshotTask', msg => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only the task runtime can snapshot this task');
      return structuredClone(this.taskExtras.get((msg.payload as { taskId: string }).taskId));
    });
    this.on('restoreTask', msg => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only AgentAbject may restore task state');
      const { taskId, snapshot } = msg.payload as { taskId: string; snapshot: ReviewTaskExtra };
      if (!snapshot) throw new Error('Missing specialist checkpoint');
      if (this.inFlight && this.inFlight.ticketId !== taskId) throw new Error('Another review is running; retry when it settles');
      this.inFlight = { ticketId: taskId, startedAt: Date.now() };
      this.taskExtras.set(taskId, { ...structuredClone(snapshot), cancelled: false });
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
      if (extra?.goalId && this.goalManagerId && extra.kind !== 'repair') {
        await this.request(request(this.id, this.goalManagerId, 'ackReview', { goalId: extra.goalId, report: this.learningReport(extra, !succeeded || extra.cancelled === true) }));
      }
      this.inFlight = undefined; this.taskExtras.delete(ticketId);
      for (const taskId of succeeded ? extra?.reviewedTaskIds ?? [] : []) {
        // The transcripts have served their purpose; free them.
        this.send(request(this.id, this.agentAbjectId!, 'releaseTask', { taskId }));
      }
      this.changed('reviewCompleted', { kind: extra?.kind ?? 'review' });

      // Drain a goal review that arrived while this one was running, the
      // one judged most valuable first when reviewer.worth acts.
      if (this.worthByGoal.size && await this.worthOrdering()) this.sortByWorth(this.pendingGoalReviews);
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
      return this.applyReviewAction(taskId, action);
    });
  }

  private async recoverLegacyReviews(): Promise<void> {
    const proposals = await this.request<Array<{ taskId: string; goalId: string; result: Record<string, unknown>; records: TranscriptResponse[] }>>(request(this.id, this.agentAbjectId!, 'getRetainedReviewProposals', {}));
    for (const proposal of proposals) {
      const goal = await this.request<{ scratchpad: Record<string, any> } | null>(request(this.id, this.goalManagerId!, 'getGoal', { goalId: proposal.goalId }));
      if (!goal || goal.scratchpad['learning/review'] !== 'partial' || Object.entries(goal.scratchpad).some(([k,v]) => k.startsWith('learning/decision/') && v.reviewTaskId === proposal.taskId)) continue;
      // Recovery supplies the available episode records, not a semantic
      // association missing from the old model response. That item requires
      // a focused repair, which receives these original records as evidence.
      const effects = Array.isArray(proposal.result.knowledgeUpdates) ? proposal.result.knowledgeUpdates : [proposal.result.knowledgeUpdates];
      const r = await this.request<{ success: boolean; decision: LearningDecision }>(request(this.id, this.goalManagerId!, 'recordLearningDecision', {
        goalId: proposal.goalId, reviewTaskId: proposal.taskId, operationId: `legacy-review:${proposal.taskId}`, effects,
        context: { recoveredFrom: proposal.taskId, evidence: proposal.result.evidence, evidenceRefs: proposal.records.map(r => `learning/task/${r.taskId}`),
          originalResult: proposal.result, originalReport: goal.scratchpad['learning/reviewOutcome'] },
      }));
      if (!r.success) throw new Error('Legacy correction journal rejected recovery');
      let decision = r.decision;
      for (const effect of decision.effects) decision = await this.changeEffect(decision, effect, { state: 'needs_repair', error: 'Recovered legacy proposal: compare original evidence and current knowledge before applying; do not repeat already saved corrections' });
    }
    this.recoveredLegacyReviews = true;
  }

  private async changeEffect(decision: LearningDecision, effect: LearningEffect, change: Record<string, unknown>): Promise<LearningDecision> {
    const r = await this.request<{ success: boolean; decision: LearningDecision }>(request(this.id, this.goalManagerId!, 'changeLearningEffect', {
      goalId: decision.goalId, decisionId: decision.id, effectId: effect.id, change,
    }), 5000);
    if (!r.success) throw new Error('Learning journal rejected progress');
    return r.decision;
  }

  /** Every proposal is durable before lookup/validation. Both action forms use this path. */
  private async proposeLearning(taskId: string, effects: unknown[], context: Record<string, unknown>): Promise<LearningDecision> {
    const extra = this.taskExtras.get(taskId)!;
    context = { ...context, scope: context.scope ?? extra.knowledgeScope };
    if (!extra.goalId || !this.goalManagerId) throw new Error('Episode-linked learning requires a goal');
    const r = await this.request<{ success: boolean; decision: LearningDecision }>(request(this.id, this.goalManagerId, 'recordLearningDecision', {
      goalId: extra.goalId, reviewTaskId: taskId, operationId: `${taskId}:${await learningFingerprint({ effects, context })}`, context, effects,
    }), 5000);
    if (!r.success) throw new Error('Learning decision identity conflict');
    let decision = r.decision;
    // Version references describe the claim in the review dossier. Unknown
    // historical versions remain unknown; do not substitute today's version.
    for (const effect of decision.effects) {
      if (!effect.attempts && effect.input.action === 'record_pattern_application' && effect.input.application) {
        const app = effect.input.application as Record<string, unknown>;
        const episodes = (extra.records ?? []).flatMap(r => (r.predictions ?? []).flatMap(p => (p.patterns ?? [])
          .filter(a => a.id === effect.input.id && (app.taskId === undefined || app.taskId === r.taskId && app.step === p.step))
          .map(a => ({ taskId: r.taskId, step: p.step, outcome: p.outcome, applicationRef: a.applicationRef }))));
        if (episodes.length === 1) decision = await this.changeEffect(decision, effect, { prepare: { ...episodes[0], verdict: app.verdict, evidence: app.evidence } });
      }
      if (!effect.attempts && effect.input.action === 'save_pattern') {
        const built = makePattern({ ...effect.input, evidence: effect.input.evidence ?? 'Candidate interpretation; see linked episode' });
        if (built.ok) decision = await this.changeEffect(decision, effect, { prepare: { action: 'save_entry', title: built.pattern.name, type: 'pattern', content: serializePattern(built.pattern), tags: ['pattern', ...(Array.isArray(effect.input.tags) ? effect.input.tags : [])] } });
      }
      if (!effect.attempts && effect.input.action === 'update_pattern') {
        const current = await this.request<any>(request(this.id, (await this.getKbId())!, 'get', { id: effect.input.id }));
        const stored = current?.pattern;
        if (stored) {
          const merged: Record<string, unknown> = { ...stored, name: current.title };
          for (const field of PATTERN_FIELDS) if (typeof effect.input[field] === 'string' && (effect.input[field] as string).trim()) merged[field] = effect.input[field];
          merged.links = [...new Set([...stored.links, ...(Array.isArray(effect.input.addLinks) ? effect.input.addLinks : [])])];
          const built = makePattern(merged);
          if (built.ok) decision = await this.changeEffect(decision, effect, { prepare: { action: 'update_entry', content: serializePattern(built.pattern), knowledgeRef: current.knowledgeRef } });
        }
      }
      const ref = extra.knowledgeRefs?.[String(effect.input.id)];
      if (!effect.attempts && !effect.input.knowledgeRef && ref) decision = await this.changeEffect(decision, effect, { prepare: { knowledgeRef: ref } });
      if (!effect.attempts && effect.input.action === 'supersede_entry') {
        // Only a complete, model-visible read can select an unchanged replacement.
        // A replacement revised in this decision is instead bound to its receipt.
        const replacementRef = extra.fullKnowledgeRefs?.[String(effect.input.replacementId)];
        decision = await this.changeEffect(decision, effect, { prepare: { replacementRef: replacementRef ?? null } });
      }
    }
    decision = await this.applyDecision(decision, extra);
    for (const e of decision.effects) if (e.state === 'applied' && e.input.action === 'record_pattern_application') (extra.applicationAssessments ??= {})[`${e.input.taskId}:${e.input.step}:${e.input.id}`] = String(e.input.verdict);
    extra.decisions = [...(extra.decisions ?? []).filter(d => d.id !== decision.id), decision];
    return decision;
  }

  private async applyDecision(initial: LearningDecision, extra?: ReviewTaskExtra): Promise<LearningDecision> {
    let decision = initial;
    const deadline = Date.now() + 8000;
    const ordered = [...decision.effects].sort((a,b) => Number(['archive_entry','supersede_entry'].includes(String(a.input.action))) - Number(['archive_entry','supersede_entry'].includes(String(b.input.action))));
    for (const original of ordered) {
      let effect = decision.effects.find(e => e.id === original.id)!;
      if (effect.state !== 'proposed' || effect.nextAttemptAt > Date.now()) continue;
      if (effect.dependsOn?.some(id => decision.effects.find(e => e.id === id)?.state !== 'applied')) continue;
      if (extra?.cancelled) { decision = await this.changeEffect(decision, effect, { state: 'waiting', error: 'Review cancelled; explicit resumption required' }); continue; }
      if (Date.now() >= deadline) break;
      if (effect.attempts >= 3) { decision = await this.changeEffect(decision, effect, { state: 'waiting', error: 'Delivery retry budget exhausted; reconcile the receipt before explicit resumption' }); continue; }
      const error = validateLearningEffect(decision, effect);
      if (error) { decision = await this.changeEffect(decision, effect, { state: 'needs_repair', error }); continue; }
      if (effect.input.action === 'no_change') { decision = await this.changeEffect(decision, effect, { state: 'applied', receipt: { disposition: 'no_change', reason: effect.input.evidence, decisionId: decision.id } }); continue; }
      try {
        decision = await this.changeEffect(decision, effect, { attempt: true });
        effect = decision.effects.find(e => e.id === effect.id)!;
        if (!(await this.getKbId())) throw new Error('KnowledgeBase unavailable');
        if (extra?.cancelled) { decision = await this.changeEffect(decision, effect, { state: 'waiting', error: 'Review cancelled before delivery' }); continue; }
        const r = await this.request<{ success: boolean; receipt?: unknown; error?: string; retryable?: boolean }>(request(this.id, this.knowledgeBaseId!, 'applyLearningDecision', {
          goalId: decision.goalId, decisionId: decision.id, effectId: effect.id,
        }), 5000);
        if (r.success && r.receipt) decision = await this.changeEffect(decision, effect, { state: 'applied', receipt: r.receipt });
        else decision = await this.changeEffect(decision, effect, { state: r.retryable ? 'proposed' : 'needs_repair', error: r.error ?? 'Receiver did not acknowledge a durable receipt' });
      } catch (err) {
        // Reuse the immutable operation on a lost acknowledgment. Never issue
        // a semantic replacement until the original receiver result is known.
        decision = await this.changeEffect(decision, effect, { error: `Delivery unresolved: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return decision;
  }

  private async drainLearningDecisions(): Promise<void> {
    if (this.drainingLearning || !this.goalManagerId || this.inFlight) return;
    this.drainingLearning = true;
    try {
      const decisions = await this.request<LearningDecision[]>(request(this.id, this.goalManagerId, 'pendingLearningDecisions', {}));
      for (const pending of decisions.slice(0, 5)) {
        const decision = await this.applyDecision(pending);
        if (decision.paused || !decision.effects.some(e => e.state === 'needs_repair') || decision.repairAttempts || !this.underDailyCap()) continue;
        const claim = await this.request<{ success: boolean; decision: LearningDecision }>(request(this.id, this.goalManagerId, 'claimLearningRepair', { goalId: decision.goalId, decisionId: decision.id }));
        if (!claim.success) continue;
        const taskId = `learning-repair-${decision.id}-${Date.now()}`;
        const refs: Record<string, string> = {};
        const claims = [];
        const targets = [...new Set(claim.decision.effects.filter(e => e.state === 'waiting' && e.repairClaimed).flatMap(e => [e.input.id, e.input.replacementId]).filter(id => typeof id === 'string'))];
        for (const id of targets) {
          const entry = await this.request<{ id: string; knowledgeRef?: string } | null>(request(this.id, this.knowledgeBaseId!, 'get', { id })).catch(() => null);
          if (entry?.knowledgeRef) refs[entry.id] = entry.knowledgeRef;
          claims.push(entry);
        }
        const records = Object.entries(claim.decision.evidence).filter(([key]) => key.startsWith('learning/task/')).map(([,r]) => r as TranscriptResponse);
        const knowledgeScope = typeof decision.context.scope === 'string' ? decision.context.scope : this.reviewScope(records);
        this.taskExtras.set(taskId, { kind: 'repair', goalId: decision.goalId, repairDecisionId: decision.id, decisions: [claim.decision], knowledgeRefs: refs, fullMaterial: JSON.stringify(claim.decision), records, knowledgeScope });
        this.inFlight = { ticketId: taskId, startedAt: Date.now() };
        try {
          await this.request(request(this.id, this.agentAbjectId!, 'startTask', { taskId,
            task: 'Repair only the unfinished learning effects. Preserve uncertainty and unaffected claims.',
            systemPrompt: this.reviewSystemPrompt() + '\nThis is one focused repair, not a new retrospective. Return done with result.repairs:[{effectId, input:{action,id,evidence,...}}]. Use evidenceRefs already recorded in the decision. If evidence does not justify a change, use no_change with a reason or leave the item waiting. Do not repeat completed effects or assessments. No additional repair turn will be scheduled automatically.',
            initialMessages: [{ role: 'user', content: JSON.stringify({ decisionId: decision.id, goalId: decision.goalId, context: { evidence: decision.context.evidence, scope: decision.context.scope, recoveredFrom: decision.context.recoveredFrom }, effects: claim.decision.effects.filter(e => e.state === 'waiting' && e.repairClaimed).slice(0,20).map(e => ({ id:e.id, input:{...e.input,content:typeof e.input.content === 'string' ? e.input.content.slice(0,1200) : undefined}, error:e.error })), evidence: Object.entries(decision.evidence).slice(0,12).map(([key,value]) => ({ key, preview:JSON.stringify(value).slice(0,1200), length:JSON.stringify(value).length })), currentClaims: claims.slice(0,20).map(e => e ? {...e,learning:undefined,pattern:undefined,content:String((e as any).content ?? '').slice(0,1200)} : null), readMore:'read_evidence with offset/length returns the complete original decision; taskId or key reads complete recorded evidence. Previews may omit important context.' }) }],
            config: { maxSteps: 3, timeout: 90000, budgetGoalId: decision.goalId, knowledgeScope },
          }), 15000);
          this.reviewsToday++;
        } catch (err) { this.inFlight = undefined; this.taskExtras.delete(taskId); log.warn(`Focused learning repair could not start: ${String(err)}`); }
        break;
      }
    } finally { this.drainingLearning = false; }
  }

  /** Shared validation and receipts for individual actions and completion batches. */
  private async applyReviewAction(taskId: string, action: AgentAction) {
    let result: { success: boolean; data?: unknown; error?: string; duplicateOf?: string };
    let advice: string[] = [];
    try {
      const extra = this.taskExtras.get(taskId);
      if (extra?.goalId && this.goalManagerId && action.action === 'repair_learning') {
        const d = await this.request<LearningDecision | null>(request(this.id,this.goalManagerId,'getLearningDecision',{goalId:extra.goalId,decisionId:action.decisionId}));
        const effect = d?.effects.find(e => e.id === action.effectId);
        if (!d || !effect || (d.reviewTaskId !== taskId && extra.repairDecisionId !== d.id)) throw new Error('Repair is outside this review');
        const input = action.input && typeof action.input === 'object' ? { ...action.input as Record<string,unknown> } : {};
        const ref = extra.knowledgeRefs?.[String(input.id)]; if (ref) input.knowledgeRef = ref;
        if (input.action === 'supersede_entry') input.replacementRef = extra.fullKnowledgeRefs?.[String(input.replacementId)] ?? null;
        const changed = await this.changeEffect(d,effect,{repair:input});
        const settled = await this.applyDecision(changed,extra);
        extra.decisions = [...(extra.decisions ?? []).filter(v => v.id !== d.id),settled];
        return {success:settled.effects.every(e => e.state==='applied' || e.state==='abandoned'),data:settled};
      }
      // New entries are compared with what the store already holds before
      // they are saved (site reviewer.dedupe): the verdict rides back with
      // the result, and a confident duplicate is turned away when it acts.
      if (action.action === 'save_entry' || (action.action === 'learn' && Array.isArray(action.effects))) {
        const screened = await this.screenSaves(taskId, action.action === 'save_entry' ? [action] : action.effects as unknown[]);
        advice = [...screened.rejected.map(r => r.message), ...screened.notes];
        if (!screened.kept.length && screened.rejected.length) {
          return this.trackReviewAction(taskId, action, { success: false, error: advice.join(' '), duplicateOf: screened.rejected[0].duplicateOf });
        }
        action = action.action === 'save_entry' ? screened.kept[0] as AgentAction : { ...action, effects: screened.kept };
      }
      if (extra?.goalId && this.goalManagerId && (action.action === 'learn' || ['save_entry','update_entry','archive_entry','supersede_entry','dispute_entry','narrow_entry','confirm_entry','no_change','save_pattern','update_pattern','record_pattern_application'].includes(action.action))) {
        const app = action.application as Record<string, unknown> | undefined;
        const context = action.action === 'learn' ? (action.context ?? {}) as Record<string, unknown> : { evidence: action.evidence ?? app?.evidence, evidenceRefs: action.evidenceRefs ?? (app?.taskId ? [`learning/task/${app.taskId}`] : undefined), assessmentRefs: app?.taskId && app.step ? [`learning/assessment/${app.taskId}:${app.step}`] : undefined, scope: action.scope };
        const decision = await this.proposeLearning(taskId, action.action === 'learn' && Array.isArray(action.effects) ? action.effects : [action], context);
        result = { success: decision.effects.every(e => e.state === 'applied'), data: decision, error: decision.effects.find(e => e.state !== 'applied')?.error };
      } else result = await this.handleAct(taskId, action);
    }
    catch (err) { result = { success: false, error: err instanceof Error ? err.message : String(err) }; }
    if (advice.length) {
      // Only data and error reach the conversation, so the advice rides there;
      // a journaled decision keeps its shape, with the advice read first.
      const text = advice.join(' ');
      if (!result.success) result = { ...result, error: `${result.error ?? 'Not saved'} ${text}` };
      else if (typeof result.data === 'string') result = { ...result, data: `${result.data}\n${text}` };
      else if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) result = { ...result, data: { advice: text, ...result.data } };
    }
    return this.trackReviewAction(taskId, action, result);
  }

  /** Record a learning action's outcome on the review, for the report and the one-time correction. */
  private trackReviewAction(taskId: string, action: AgentAction, result: { success: boolean; data?: unknown; error?: string; duplicateOf?: string }) {
    const extra = this.taskExtras.get(taskId);
    if (extra && ['assess_prediction', 'record_pattern_application', 'save_entry', 'update_entry', 'archive_entry', 'forget_entry', 'mark_useful', 'save_pattern', 'update_pattern', 'merge_entries', 'author_skill'].includes(action.action)) {
      const app = action.application as Record<string, unknown> | undefined;
      const key = JSON.stringify([action.action, action.id ?? action.title ?? action.name ?? action.ids ?? '', action.taskId ?? app?.taskId ?? '', action.step ?? app?.step ?? '']);
      const updates = extra.updates ??= [];
      const update: LearningUpdate = { key, action: structuredClone(action), status: result.duplicateOf ? 'duplicate' : result.success ? 'saved' : /unresolved|provenance|reference/i.test(result.error ?? '') ? 'unresolved' : 'rejected', result: result.data, error: result.error };
      updates.push(update);
      return { ...result, learningStatus: update.status };
    }
    return result;
  }

  /**
   * Keep the reviewer's verdict on the user-facing summary with the goal, and
   * say so in the log when the summary misreported: that is the one review
   * finding a person reading the log wants immediately, since the summary
   * was the thing they read.
   */
  private async recordSummaryFidelity(extra: ReviewTaskExtra, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const { verdict, explanation } = value as { verdict?: unknown; explanation?: unknown };
    if (verdict !== 'consistent' && verdict !== 'misreported' && verdict !== 'unverifiable') {
      extra.completionIssues?.push('summaryFidelity.verdict must be consistent, misreported or unverifiable');
      return;
    }
    const fidelity = { verdict, explanation: typeof explanation === 'string' ? explanation.slice(0, 2000) : undefined, at: Date.now() };
    if (verdict === 'misreported') log.warn(`goal ${extra.goalId?.slice(0, 8) ?? '?'}: user-facing summary misreported — ${fidelity.explanation ?? '(no explanation)'}`);
    if (!extra.goalId || !this.goalManagerId) return;
    try {
      await this.request(request(this.id, this.goalManagerId, 'writeGoalData', { goalId: extra.goalId, key: 'learning/summary-fidelity', value: fidelity }), 10000);
      extra.summaryFidelityRecorded = true;
    } catch (err) {
      extra.completionIssues?.push(`Summary fidelity not recorded: ${String(err)}`);
    }
  }

  private async completeReview(taskId: string, result: unknown) {
    const extra = this.taskExtras.get(taskId);
    if (!extra) return { accepted: true, result: this.learningReport(undefined, true) };
    const batch = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
    const actions: AgentAction[] = [];
    if ('assessments' in batch || 'applications' in batch || 'knowledgeUpdates' in batch || 'unresolvedReason' in batch) extra.completionIssues = [];
    else extra.completionIssues ??= [];
    for (const [field, action] of [['assessments', 'assess_prediction'], ['applications', 'record_pattern_application']] as const) {
      const items = batch[field];
      if (items === undefined) continue;
      if (!Array.isArray(items)) { extra.completionIssues.push(`${field} must be an array`); continue; }
      for (const item of items.slice(0, 100)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { extra.completionIssues.push(`Invalid ${field} entry`); continue; }
        actions.push({ ...item, action });
      }
      if (items.length > 100) extra.completionIssues.push(`${items.length - 100} ${field} entries exceed the batch limit and remain unprocessed`);
    }
    // Keep even malformed corrections as addressable work, never generic strings.
    const corrections = batch.knowledgeUpdates === undefined ? [] : Array.isArray(batch.knowledgeUpdates) ? batch.knowledgeUpdates : [batch.knowledgeUpdates];
    // One completion can record a whole modest review, without an LLM turn
    // per assessment. Stop below the completion RPC deadline; never loop on a
    // receiver failure or require invented certainty to finish.
    const deadline = Date.now() + 10000;
    for (let i = 0; i < actions.length; i++) {
      if (extra.cancelled) break;
      if (Date.now() >= deadline) { extra.completionIssues.push(`${actions.length - i} updates remain unprocessed after the completion time budget`); break; }
      if (['update_entry', 'archive_entry'].includes(actions[i].action)) {
        const previous = extra.updates?.filter(u => u.action.id === actions[i].id && ['update_entry', 'archive_entry'].includes(u.action.action)).at(-1);
        if (previous?.status === 'saved' && JSON.stringify(previous.action) === JSON.stringify(actions[i])) continue;
      }
      await this.applyReviewAction(taskId, actions[i]);
    }
    if (extra.kind === 'repair' && extra.decisions?.[0]) {
      let decision = extra.decisions[0];
      for (const repair of Array.isArray(batch.repairs) ? batch.repairs.slice(0, 20) : []) {
        const effect = decision.effects.find(e => e.id === repair?.effectId && e.state === 'waiting' && e.repairClaimed);
        if (!effect || !repair.input || typeof repair.input !== 'object' || extra.cancelled) continue;
        const input = { ...repair.input };
        if (input.id && extra.knowledgeRefs?.[input.id]) input.knowledgeRef = extra.knowledgeRefs[input.id];
        if (input.action === 'supersede_entry') input.replacementRef = extra.fullKnowledgeRefs?.[input.replacementId] ?? null;
        decision = await this.changeEffect(decision, effect, { repair: input });
      }
      extra.decisions = [await this.applyDecision(decision, extra)];
    } else if (corrections.length && extra.goalId && this.goalManagerId) {
      // New entries in the batch are screened like single saves (site
      // reviewer.dedupe); one turned away is on record, not pending.
      const screened = await this.screenSaves(taskId, corrections);
      for (const r of screened.rejected) {
        (extra.updates ??= []).push({ key: JSON.stringify(['save_entry', r.item.title ?? '', '', '']), action: { ...r.item, action: 'save_entry' }, status: 'duplicate', error: r.message });
      }
      if (screened.notes.length) log.info(`[decision] reviewer.dedupe completion batch: ${screened.notes.join(' ')}`);
      if (screened.kept.length) {
        try { await this.proposeLearning(taskId, screened.kept, { evidence: batch.evidence, evidenceRefs: batch.evidenceRefs, scope: batch.scope,
          assessmentRefs: Object.keys(extra.assessments ?? {}).map(k => `learning/assessment/${k}`),
          selections: (extra.records ?? []).flatMap(r => r.injectedKnowledge ?? []),
        }); } catch (err) { extra.completionIssues.push(`Corrections not acknowledged by journal: ${String(err)}`); }
      }
    } else for (const item of corrections) {
      // Standalone/curation compatibility until an episode owner exists.
      if (item && typeof item === 'object') await this.applyReviewAction(taskId, item);
      else extra.completionIssues.push('Invalid standalone correction');
    }
    if (typeof batch.unresolvedReason === 'string' && batch.unresolvedReason.trim()) extra.completionIssues.push(batch.unresolvedReason.trim());
    await this.recordSummaryFidelity(extra, batch.summaryFidelity);
    let missing = this.missingAssessments(extra);
    // Judged episodes still missing an assessment are recorded from the
    // decision model's verdicts instead of an extra model turn: confident
    // ones as judged, the rest unresolved. Episodes it could not judge still
    // go to the correction below (site reviewer.predictions, act).
    if (missing.length && !extra.cancelled && extra.kind === 'review' && !extra.automatedAssessments && extra.judgments?.predictions?.mode === 'act') {
      await this.recordAutomatedAssessments(taskId, extra, missing);
      missing = this.missingAssessments(extra);
    }
    // A goal review owes a verdict on the user-facing summary. Missing, it is
    // asked for in the one correction; still missing after that, the report
    // says so instead of recording nothing.
    const fidelityMissing = extra.kind === 'review' && !!extra.goalId && !extra.summaryFidelityRecorded && batch.summaryFidelity === undefined;
    if (!extra.cancelled && extra.kind === 'review' && (missing.length || fidelityMissing) && !extra.completionIssues.length && !extra.completionCorrectionSent) {
      extra.completionCorrectionSent = true;
      const parts: string[] = [];
      if (missing.length) {
        const budget = Math.max(0, Math.floor(12000 / missing.length) - 160);
        const gaps = missing.map(({ taskId, p }) => `${taskId} step ${p.step}: expected=${p.expect.slice(0, budget / 2)}; actual=${String(p.actual ?? '').slice(0, budget / 2)}`).join('\n');
        parts.push(`${missing.length} predictions still lack semantic assessments:\n${gaps}\nIn your next done action, include only missing assessments in result: {assessments:[{taskId,step,verdict,explanation}]}. Compare expected and actual evidence; successful operation status does not establish the prediction. Use read_evidence with taskId and step for full observations, or unresolved with a specific evidence gap. No new reusable lesson is required. If the material cannot be assessed, include unresolvedReason.`);
      }
      if (fidelityMissing) {
        parts.push('The result has no summaryFidelity verdict. Include summaryFidelity: { verdict: "consistent" | "misreported" | "unverifiable", explanation } in your next done result, comparing the user-facing result with the newest verification record.');
      }
      return { accepted: false, reason: `${parts.join('\n\n')}\nThis correction is requested once; remaining gaps settle as partial.` };
    }
    // Still no verdict after the correction: a confident decision-model
    // verdict is recorded with its provenance. The reviewer's own field,
    // whenever given, is the one on record (site reviewer.fidelity, act).
    if (fidelityMissing && !extra.cancelled) await this.recordAutomatedFidelity(extra);
    if (fidelityMissing && !extra.cancelled && !extra.summaryFidelityRecorded) extra.completionIssues.push('No summaryFidelity verdict was given for the user-facing summary.');
    if (!extra.cancelled && extra.kind === 'review') await this.fillPatternApplications(taskId, extra);
    const report = this.learningReport(extra, extra.cancelled);
    return { accepted: true, result: report, evidence: report };
  }

  /** Observed episodes with a stated prediction and no assessment yet; GoalManager keeps the rest unresolved. */
  private missingAssessments(extra: ReviewTaskExtra): Array<{ taskId: string; p: PredictionRecord }> {
    return (extra.records ?? []).flatMap(r => (r.predictions ?? [])
      .filter(p => p.expect?.trim() && p.outcome !== 'unknown' && !extra.assessments?.[`${r.taskId}:${p.step}`]).map(p => ({ taskId: r.taskId, p })));
  }

  private learningReport(extra?: ReviewTaskExtra, interrupted = false) {
    const updates = extra?.updates ?? [];
    const assessments = extra?.assessments ?? {};
    const episodes = new Map<string, PredictionRecord>((extra?.records ?? []).flatMap(r => (r.predictions ?? []).map(p => [`${r.taskId}:${p.step}`, p] as const)));
    const unassessed = [...episodes].filter(([key]) => !assessments[key]).map(([key]) => key);
    const counts = { supported: 0, contradicted: 0, unresolved: unassessed.length };
    for (const [key, a] of Object.entries(assessments)) if (episodes.has(key) && a.verdict in counts) counts[a.verdict as keyof typeof counts]++;
    const latest = new Map(updates.map(u => [u.key, u]));
    const journaled = (u: LearningUpdate) => !!u.result && typeof u.result === 'object' && (u.result as Partial<LearningDecision>).version === 1;
    const saved = [...new Map(updates.filter(u => u.status === 'saved' && !journaled(u)).map(u => [u.key, u])).values()];
    const pending = [...latest.values()].filter(u => u.status !== 'saved' && u.status !== 'duplicate' && !journaled(u));
    const patternCounts = { helpful: 0, harmful: 0, inconclusive: 0, unresolved: 0 };
    const unassessedApplications: Array<{ taskId: string; step: number; id: string; applicationRef?: string }> = [];
    for (const r of extra?.records ?? []) for (const p of r.predictions ?? []) for (const applied of p.patterns ?? []) {
      const verdict = extra?.applicationAssessments?.[`${r.taskId}:${p.step}:${applied.id}`];
      if (verdict === 'helpful' || verdict === 'harmful' || verdict === 'inconclusive') patternCounts[verdict]++;
      else { patternCounts.unresolved++; unassessedApplications.push({ taskId: r.taskId, step: p.step, id: applied.id, applicationRef: applied.applicationRef }); }
    }
    // Report the causal chain using recorded references, not a second model pass.
    // A shared decision may consider several episodes; it is not proof that each
    // effect was caused by every prediction in that decision's context.
    // The report is a summary that names its evidence, not a copy of it. The
    // observations, decisions and assessments it refers to are already on
    // record under the goal; carrying their bodies here made a single review
    // result run to ten megabytes, and the session store held each result
    // several times over. Long text is clipped, records are reduced to their
    // keys and states.
    const clip = (v: unknown, max = 400): string => {
      const text = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
      return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
    };
    const episodesWithLearning = [...episodes].map(([key, prediction]) => {
      const assessmentRef = `learning/assessment/${key}`;
      const decisions = (extra?.decisions ?? []).filter(d =>
        (Array.isArray(d.context.assessmentRefs) && d.context.assessmentRefs.includes(assessmentRef))
        || Object.hasOwn(d.evidence, assessmentRef));
      const assessment = assessments[key];
      return { episode: key, expected: clip(prediction.expect), observationRef: prediction.actualRef,
        actual: clip(prediction.actual), appliedPatterns: (prediction.patterns ?? []).map(p => p.id),
        assessment: assessment ? { verdict: assessment.verdict, explanation: clip(assessment.explanation, 600) } : { verdict: 'unresolved', explanation: 'No recorded assessment' },
        assessmentRef, consideredBy: decisions.map(d => ({ decisionId: d.id,
          effects: d.effects.map(e => ({ effectId: e.id, action: e.input.action, knowledgeId: e.input.id, state: e.state })) })) };
    });
    const learningEffects = (extra?.decisions ?? []).flatMap(d => d.effects.map(e => ({ decisionId: d.id, id: e.id, state: e.state, action: e.input.action, knowledgeId: e.input.id })));
    const brief = (u: LearningUpdate) => ({ key: u.key, action: u.action.action, status: u.status, error: u.error ? clip(u.error, 300) : undefined });
    const allSaved = [...saved.map(brief), ...learningEffects.filter(e => e.state === 'applied')];
    const allPending = [...pending.map(brief), ...learningEffects.filter(e => e.state !== 'applied' && e.state !== 'abandoned')];
    const status = interrupted || learningEffects.some(e => e.state !== 'applied' && e.state !== 'abandoned') || extra?.completionIssues?.length || pending.length || counts.unresolved || patternCounts.unresolved ? 'partial' : 'complete';
    return { status, interrupted, saved: allSaved, pending: allPending,
      decisions: (extra?.decisions ?? []).map(d => ({ id: d.id, effects: d.effects.map(e => ({ id: e.id, state: e.state, action: e.input.action, knowledgeId: e.input.id })) })),
      attempts: updates.map(brief), limitations: extra?.completionIssues ?? [],
      predictions: { total: episodes.size, ...counts, unassessed, episodes: episodesWithLearning },
      patterns: { ...patternCounts, unassessed: unassessedApplications },
      summary: `Learning review ${status}: ${allSaved.length} updates saved, ${allPending.length} pending. Predictions: ${counts.supported} supported, ${counts.contradicted} contradicted, ${counts.unresolved} unresolved. Pattern applications: ${patternCounts.helpful} helpful, ${patternCounts.harmful} harmful, ${patternCounts.inconclusive} inconclusive, ${patternCounts.unresolved} unassessed.` };
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

    // How much could this task teach (site reviewer.worth)? Acting, a
    // confidently routine success is released without the review, and the
    // day's reserved slots go to valuable tasks; this one keeps the counter,
    // as a task past the daily cap does.
    const worth = await this.judgeWorth(undefined, () => this.worthState([record]));
    if (worth) {
      const plan = this.worthPlan(worth, record.phase === 'error');
      this.logWorth(`task ${record.taskId.slice(0, 8)}`, worth, plan);
      if (worth.mode === 'act' && plan === 'routine') {
        this.send(request(this.id, this.agentAbjectId!, 'releaseTask', { taskId: ev.taskId }));
        return;
      }
      if (worth.mode === 'act' && plan === 'defer') { this.taskCounters.set(agentName, count); return; }
      // Another review may have started while this one was judged.
      if (this.inFlight) { this.taskCounters.set(agentName, count); return; }
    }

    const material =
      `## Task under review (standalone, no goal)\n` +
      this.formatTaskSection(record, record.transcript);

    await this.launchReview(
      `Review the finished "${record.agentName}" task and capture durable learnings.`,
      material,
      [record.taskId], undefined, [record], { worth },
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

  /** Hold a goal review until the in-flight one finishes; GoalManager keeps it durable beyond this queue. */
  private queueGoalReview(review: PendingGoalReview): void {
    if (this.pendingGoalReviews.length < MAX_PENDING_GOAL_REVIEWS
        && !this.pendingGoalReviews.some(p => p.goalId === review.goalId)) {
      this.pendingGoalReviews.push(review);
    }
  }

  private async prepareGoalReview(review: PendingGoalReview): Promise<void> {
    if (!(await this.getKbId())) return;
    this.clearStuckReview();
    if (this.inFlight) {
      this.queueGoalReview(review);
      return;
    }
    if (!this.underDailyCap()) return;
    // Judged low in value and deferred already: it waits out the day's
    // reserved slots without fetching its evidence again (reviewer.worth, act).
    if (this.worthByGoal.get(review.goalId)?.deferred && this.inReserveZone()
        && await this.decisionSiteMode('reviewer.worth') === 'act') return;

    const goal = await this.request<{ title?: string; description?: string; result?: string; scratchpad?: Record<string, unknown> } | null>(
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

    // Decision-model judgments over the gathered evidence. Each is optional:
    // without them the review runs exactly as before. Inside the day's
    // reserved slots, value is judged first, so a review deferred for them
    // spends one call (sites reviewer.worth, .predictions, .fidelity, .patterns).
    const verification = verificationRecordOf(goal?.scratchpad ?? {});
    const userResult = typeof goal?.result === 'string' ? goal.result : undefined;
    const failed = review.outcome === 'failed' || all.some(r => r.phase === 'error');
    const worthState = () => this.worthState(all, { title: goal?.title, outcome: review.outcome, detail: review.detail, userResult }, verification);
    const subject = `goal ${review.goalId.slice(0, 8)}`;
    let worth = this.inReserveZone() ? await this.judgeWorth(review.goalId, worthState) : undefined;
    if (worth?.mode === 'act' && worth.highP < 0.5 && !this.routineVerdict(worth, failed)) {
      this.markDeferred(review.goalId);
      this.logWorth(subject, worth, 'defer');
      return;
    }
    const [judgedWorth, judgments] = await Promise.all([
      worth ? Promise.resolve(worth) : this.judgeWorth(review.goalId, worthState),
      this.judgeReviewEvidence(review.goalId, all, review.outcome, verification, userResult),
    ]);
    worth = judgedWorth;
    if (worth) {
      const plan = this.worthPlan(worth, failed, judgments);
      this.logWorth(subject, worth, plan);
      if (worth.mode === 'act' && plan === 'routine') {
        await this.settleRoutineReview(review, goalTaskIds, all, worth, judgments);
        return;
      }
      if (worth.mode === 'act' && plan === 'defer') { this.markDeferred(review.goalId); return; }
    }
    // Another review may have started while the judgments ran; this one waits its turn.
    if ((worth || judgments) && this.inFlight) { this.queueGoalReview(review); return; }

    // Split the transcript budget across tasks, larger tasks trimmed first.
    const perTask = Math.max(6000, Math.floor(GOAL_TRANSCRIPT_BUDGET / records.length));
    let material =
      `## Goal under review\n` +
      `Title: ${goal?.title ?? '(unknown)'}\n` +
      `Description: ${(goal?.description ?? '').slice(0, 1500)}\n` +
      `Outcome: ${review.outcome}${review.detail ? ` (${review.detail.slice(0, 500)})` : ''}\n` +
      `Tasks reviewed: ${records.length}${goalTaskIds.length > records.length ? ` of ${goalTaskIds.length}` : ''}\n`;
    // What the user was told, next to what the capability owners recorded.
    // A summary that quotes a figure no recorded run supports is a finding
    // in its own right, whatever the goal's outcome.
    material += `\n### User-facing result (what the user was told)\n${(userResult ?? '(none recorded)').slice(0, 4000)}\n`;
    material += `\n### Verification record (capability-owner receipts, newest first)\n${renderVerificationRecord(verification)}\n`;
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

    this.worthByGoal.delete(review.goalId);
    await this.launchReview(
      `Review the ${review.outcome} goal "${(goal?.title ?? review.goalId).slice(0, 60)}" and capture durable learnings.`,
      material,
      goalTaskIds,   // durable records retain evidence after transcript release
      review.goalId, all, { worth, judgments },
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Decision-model judgments (sites reviewer.*)
  //
  // Each site's mode rides back on its outcome: advise hands the verdict to
  // the reviewer model as a prior, act lets a confident verdict take effect.
  // Every verdict is logged once. A null outcome, a missing answer or a
  // verdict short of its threshold leaves the review as it was.
  // ═══════════════════════════════════════════════════════════════════

  private decisionScope(goalId?: string, taskId?: string): { goalId?: string; taskId?: string; onBehalfOf: string } {
    return { ...(goalId ? { goalId } : {}), ...(taskId ? { taskId } : {}), onBehalfOf: this.manifest.name };
  }

  /** Inside the day's last review slots, which wait for reviews judged valuable. */
  private inReserveZone(): boolean {
    return this.reviewsToday >= MAX_REVIEWS_PER_DAY - RESERVED_REVIEW_SLOTS;
  }

  private markDeferred(goalId: string): void {
    const cached = this.worthByGoal.get(goalId);
    if (cached) cached.deferred = true;
  }

  /**
   * Whether review order follows judged value: only when reviewer.worth acts.
   * Callers check that something was judged first, so an empty cache adds
   * no wait to the drain.
   */
  private async worthOrdering(): Promise<boolean> {
    return await this.decisionSiteMode('reviewer.worth') === 'act';
  }

  /** Valuable reviews first, deferred ones last, unjudged ones between; stable, in place. */
  private sortByWorth<T extends { goalId: string }>(reviews: T[]): T[] {
    const rank = (goalId: string): number => {
      const w = this.worthByGoal.get(goalId);
      return !w ? 1 : w.highP >= 0.5 ? 2 : w.deferred ? 0 : 1;
    };
    return reviews.sort((a, b) => rank(b.goalId) - rank(a.goalId));
  }

  /** What a learning-value judgment sees: outcomes, counts and names, never whole transcripts. */
  private worthState(records: TranscriptResponse[], goal?: { title?: string; outcome: string; detail?: string; userResult?: string }, verification: VerificationRecordEntry[] = []): Record<string, unknown> {
    return {
      goal: goal ? { title: clipText(goal.title ?? '(unknown)', 200), outcome: goal.outcome, detail: goal.detail ? clipText(goal.detail, 300) : null } : null,
      user_result: goal ? clipText(goal.userResult ?? '(none recorded)', 800) : null,
      tasks: records.slice(0, 12).map(r => {
        const predictions = r.predictions ?? [];
        return {
          agent: r.agentName, phase: r.phase, steps: r.steps,
          error: r.error ? clipText(r.error, 200) : null,
          predictions: predictions.length,
          // A judged verdict, where the runtime made one, over the operation-status comparison.
          contradicted_predictions: predictions.filter(p => (p.decisionVerdict?.verdict ?? p.verdict) === 'contradicted').length,
          failed_actions: predictions.filter(p => p.outcome === 'failure').length,
          retries: predictions.filter((p, i) => i > 0 && predictions[i - 1].outcome === 'failure' && predictions[i - 1].action === p.action).length,
        };
      }),
      injected_knowledge: [...new Set(records.flatMap(r => (r.injectedKnowledge ?? []).map(k => clipText(k.title, 120))))].slice(0, 20),
      verification: verification.length ? clipText(renderVerificationRecord(verification.slice(0, 3)), 1500) : 'none recorded',
    };
  }

  /**
   * How much a finished goal or standalone task could teach (site
   * reviewer.worth). Goal verdicts are kept, so a review deferred for the
   * day's reserved slots is judged once rather than on every drain.
   */
  private async judgeWorth(goalId: string | undefined, state: () => Record<string, unknown>): Promise<WorthVerdict | undefined> {
    const mode = await this.decisionSiteMode('reviewer.worth');
    if (mode === 'off') return undefined;
    const cached = goalId ? this.worthByGoal.get(goalId) : undefined;
    if (cached) return { ...cached, mode };
    const outcome = await this.askDecision('reviewer.worth', boundDecisionState(state()), worthQuestions(), this.decisionScope(goalId));
    const score = scoreOf(outcome, 'learning_value');
    if (!outcome || !score) return undefined;
    const pr = score.probabilities;
    const level = topLevel(score);
    const verdict: WorthVerdict = {
      mode: outcome.mode, level, levelP: pr[String(level)] ?? 0, routineP: pr['0'] ?? 0,
      highP: (pr['2'] ?? 0) + (pr['3'] ?? 0),
      // Unanswered, a conflict is assumed: the routine shortcut needs a clear no.
      conflict: noulOf(outcome, 'knowledge_conflict') ?? 1,
      emulated: outcome.emulated,
    };
    if (goalId) {
      this.worthByGoal.set(goalId, verdict);
      while (this.worthByGoal.size > WORTH_CACHE_MAX) this.worthByGoal.delete(this.worthByGoal.keys().next().value!);
    }
    return verdict;
  }

  /** A routine verdict sure enough to settle a review without the model pass. */
  private routineVerdict(worth: WorthVerdict, failed: boolean, judgments?: ReviewJudgments): boolean {
    if (failed || worth.routineP < ROUTINE_MIN_P || worth.conflict >= ROUTINE_MAX_CONFLICT) return false;
    // Sibling judgments that already see trouble keep the full review.
    const f = judgments?.fidelity;
    if (f && !f.deterministic && f.verdict === 'misreported' && f.p >= 0.5) return false;
    return !Object.values(judgments?.predictions?.byEpisode ?? {}).some(j => (j.probabilities.contradicted ?? 0) >= 0.5);
  }

  private worthPlan(worth: WorthVerdict, failed: boolean, judgments?: ReviewJudgments): 'routine' | 'defer' | 'priority' | 'review' {
    if (this.routineVerdict(worth, failed, judgments)) return 'routine';
    if (worth.highP >= 0.5) return 'priority';
    return this.inReserveZone() ? 'defer' : 'review';
  }

  private logWorth(subject: string, worth: WorthVerdict, plan: ReturnType<TaskReviewer['worthPlan']>): void {
    const what = {
      routine: 'settle as routine without the full review',
      defer: `defer while the day's last ${RESERVED_REVIEW_SLOTS} review slots wait for valuable reviews`,
      priority: 'review ahead of routine work',
      review: 'review',
    }[plan];
    log.info(`[decision:${worth.mode}] reviewer.worth ${subject}: level ${worth.level}@${fmtP(worth.levelP)} routine=${fmtP(worth.routineP)} conflict=${fmtP(worth.conflict)}; ${worth.mode === 'act' ? what : `would ${what}`}`);
  }

  /**
   * Settle a goal review judged confidently routine (site reviewer.worth,
   * act): record what the sibling sites may record under their own act
   * rules, acknowledge through the usual ack with a short routine report,
   * and release the transcripts as a finished review does.
   */
  private async settleRoutineReview(review: PendingGoalReview, reviewedTaskIds: string[], records: TranscriptResponse[], worth: WorthVerdict, judgments?: ReviewJudgments): Promise<void> {
    const ticket = `routine-${review.goalId}-${Date.now()}`;
    const extra: ReviewTaskExtra = { kind: 'review', goalId: review.goalId, records, reviewedTaskIds, judgments, completionIssues: [], knowledgeScope: this.reviewScope(records) };
    this.taskExtras.set(ticket, extra);
    try {
      await this.recordAutomatedAssessments(ticket, extra, this.missingAssessments(extra));
      await this.recordAutomatedFidelity(extra);
      await this.fillPatternApplications(ticket, extra);
      const report = this.learningReport(extra);
      await this.request(request(this.id, this.goalManagerId!, 'ackReview', { goalId: review.goalId, report: {
        ...report,
        routine: { level: worth.level, p: worth.routineP, knowledgeConflict: worth.conflict, emulated: worth.emulated },
        summary: `Routine: settled without the full learning review (${provenance({ p: worth.routineP, emulated: worth.emulated })}; knowledge conflict p=${fmtP(worth.conflict)}). ${report.summary}`,
      } }), 10000);
      for (const taskId of reviewedTaskIds) this.send(request(this.id, this.agentAbjectId!, 'releaseTask', { taskId }));
      this.changed('reviewCompleted', { kind: 'review', routine: true });
      log.info(`Routine review settled for goal ${review.goalId.slice(0, 8)}: ${report.summary}`);
    } finally {
      this.taskExtras.delete(ticket);
      this.worthByGoal.delete(review.goalId);
    }
  }

  /** Predictions, summary fidelity and pattern applications, judged together when a goal review launches. */
  private async judgeReviewEvidence(goalId: string, records: TranscriptResponse[], outcome: 'completed' | 'failed', verification: VerificationRecordEntry[], userResult?: string): Promise<ReviewJudgments | undefined> {
    const [predictions, fidelity, patterns] = await Promise.all([
      this.judgePredictions(goalId, records).catch(() => undefined),
      this.judgeFidelity(goalId, records, verification, userResult).catch(() => undefined),
      this.judgePatterns(goalId, records, outcome).catch(() => undefined),
    ]);
    if (!predictions && !fidelity && !patterns) return undefined;
    return { ...(predictions ? { predictions } : {}), ...(fidelity ? { fidelity } : {}), ...(patterns ? { patterns } : {}) };
  }

  /**
   * Were the episodes' predictions borne out (site reviewer.predictions)?
   * One request covers every episode with a stated prediction and an
   * observed outcome; the rest GoalManager already keeps unresolved.
   */
  private async judgePredictions(goalId: string, records: TranscriptResponse[]): Promise<ReviewJudgments['predictions']> {
    const episodes = records.flatMap(r => (r.predictions ?? []).filter(p => p.expect?.trim() && p.outcome !== 'unknown').map(p => ({ r, p })))
      .slice(0, MAX_JUDGED_EPISODES);
    if (!episodes.length || await this.decisionSiteMode('reviewer.predictions') === 'off') return undefined;
    const perActual = Math.min(2400, Math.max(400, Math.floor(60000 / episodes.length)));
    const state = { episodes: episodes.map(({ r, p }, i) => ({
      i, task: r.taskId, agent: r.agentName, step: p.step, action: p.action,
      expect: clipText(p.expect, 600), outcome: p.outcome, actual: clipText(p.actual ?? '(no observation recorded)', perActual),
      ...(p.decisionVerdict ? { prior: { verdict: p.decisionVerdict.verdict, confidence: p.decisionVerdict.confidence, emulated: p.decisionVerdict.emulated } } : {}),
    })) };
    const outcome = await this.askDecision('reviewer.predictions', boundDecisionState(state), reviewPredictionQuestions(episodes.length), this.decisionScope(goalId));
    if (!outcome) return undefined;
    const byEpisode: Record<string, Judgment> = {};
    episodes.forEach(({ r, p }, i) => {
      const answer = choiceOf(outcome, `q_${i}`);
      if (answer) byEpisode[`${r.taskId}:${p.step}`] = judgmentFrom(answer, outcome.emulated);
    });
    if (!Object.keys(byEpisode).length) return undefined;
    const counts: Record<string, number> = {};
    for (const j of Object.values(byEpisode)) counts[j.choice] = (counts[j.choice] ?? 0) + 1;
    const sure = Object.values(byEpisode).filter(j => j.p >= AUTO_ASSESS_MIN_P).length;
    log.info(`[decision:${outcome.mode}] reviewer.predictions goal ${goalId.slice(0, 8)}: ${JSON.stringify(counts)}; ${sure}/${episodes.length} at p>=${AUTO_ASSESS_MIN_P}`);
    return { mode: outcome.mode, byEpisode };
  }

  /**
   * Does the user-facing result match the verification record (site
   * reviewer.fidelity)? With no record or no result there is nothing to
   * compare: unverifiable, settled without a call.
   */
  private async judgeFidelity(goalId: string, records: TranscriptResponse[], verification: VerificationRecordEntry[], userResult?: string): Promise<ReviewJudgments['fidelity']> {
    const mode = await this.decisionSiteMode('reviewer.fidelity');
    if (mode === 'off') return undefined;
    if (!verification.length || !userResult?.trim()) return { mode, verdict: 'unverifiable', p: 1, emulated: false, deterministic: true };
    type Receipt = { kind: string; command: string | null; exit: number | null; testSummary: unknown; failures: number | null; note: string | null; atMs: number };
    const receipts = verification.flatMap((v): Receipt[] => {
      const runs = (['verify', 'check'] as const).flatMap((kind): Receipt[] => {
        const run = v[kind];
        return run ? [{ kind, command: clipText(run.command, 300), exit: run.exitCode, testSummary: run.testSummary ?? null, failures: run.failureCount ?? null, note: v.gate?.note ? clipText(v.gate.note, 300) : null, atMs: run.at }] : [];
      });
      return runs.length ? runs : v.gate ? [{ kind: 'gate', command: null, exit: null, testSummary: null, failures: null, note: clipText(`${v.gate.ok ? 'ok' : 'NOT ok'}: ${v.gate.note}`, 300), atMs: v.at }] : [];
    }).sort((a, b) => b.atMs - a.atMs).slice(0, 10)
      .map(({ atMs, ...rest }) => ({ ...rest, at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : 'unknown' }));
    const state = {
      user_result: clipText(userResult, 4000),
      receipts,
      task_reports: records.slice(0, 8).map(r => ({ agent: r.agentName, outcome: r.phase, report: clipText(r.phase === 'error' ? r.error ?? r.result : r.result ?? r.error ?? '', 600) })),
    };
    const outcome = await this.askDecision('reviewer.fidelity', boundDecisionState(state), fidelityQuestions(), this.decisionScope(goalId));
    const answer = choiceOf(outcome, 'fidelity');
    if (!outcome || !answer || (answer.choice !== 'consistent' && answer.choice !== 'misreported')) return undefined;
    const judged = { mode: outcome.mode, verdict: answer.choice, p: answer.probabilities[answer.choice] ?? 0,
      staleFigure: noulOf(outcome, 'stale_figure'), caveatDropped: noulOf(outcome, 'caveat_dropped'), emulated: outcome.emulated } as const;
    const line = `reviewer.fidelity goal ${goalId.slice(0, 8)}: ${judged.verdict}@${fmtP(judged.p)} stale_figure=${fmtP(judged.staleFigure)} caveat_dropped=${fmtP(judged.caveatDropped)}`;
    if (outcome.mode === 'act' && judged.verdict === 'misreported' && judged.p >= AUTO_FIDELITY_MIN_P) log.warn(`[decision:act] ${line}: the user-facing summary looks misreported`);
    else log.info(`[decision:${outcome.mode}] ${line}`);
    return judged;
  }

  /**
   * Did each declared pattern application help, harm, or stay inconclusive
   * (site reviewer.patterns)? An unobserved outcome is inconclusive by rule.
   */
  private async judgePatterns(goalId: string, records: TranscriptResponse[], goalOutcome: 'completed' | 'failed'): Promise<ReviewJudgments['patterns']> {
    const applications = records.flatMap(r => (r.predictions ?? []).flatMap(p => (p.patterns ?? []).map(a => ({ r, p, a })))).slice(0, MAX_JUDGED_APPLICATIONS);
    if (!applications.length) return undefined;
    const siteMode = await this.decisionSiteMode('reviewer.patterns');
    if (siteMode === 'off') return undefined;
    const byApplication: Record<string, Judgment> = {};
    const key = (x: typeof applications[number]) => `${x.r.taskId}:${x.p.step}:${x.a.id}`;
    for (const x of applications) {
      if (x.p.outcome === 'unknown') byApplication[key(x)] = { choice: 'inconclusive', p: 1, probabilities: { inconclusive: 1 }, emulated: false, deterministic: true };
    }
    const judged = applications.filter(x => x.p.outcome !== 'unknown');
    let mode: DecisionMode = siteMode;
    if (judged.length) {
      const kb = await this.getKbId();
      const ids = [...new Set(judged.map(x => x.a.id))];
      const entries = new Map(await Promise.all(ids.map(async id => [id, kb
        ? await this.request<{ title?: string; content?: string; pattern?: import('../core/pattern.js').PatternBody } | null>(request(this.id, kb, 'get', { id }), 10000).catch(() => null)
        : null] as const)));
      const state = { goal_outcome: goalOutcome, applications: judged.map((x, i) => {
        const entry = entries.get(x.a.id);
        const body = entry?.pattern ?? (entry?.content ? readPattern(entry.content, entry.title) : undefined);
        return { i,
          pattern: { id: x.a.id, name: entry?.title ?? body?.name ?? x.a.id, context: clipText(body?.context ?? '(unavailable)', 400), therefore: clipText(body?.therefore ?? '(unavailable)', 400) },
          why: clipText(x.a.why, 400),
          episode: { task: x.r.taskId, step: x.p.step, task_outcome: x.r.phase, expect: clipText(x.p.expect || '(not stated)', 400), outcome: x.p.outcome, actual: clipText(x.p.actual ?? '(no observation recorded)', 800) } };
      }) };
      const outcome = await this.askDecision('reviewer.patterns', boundDecisionState(state), patternQuestions(judged.length), this.decisionScope(goalId));
      if (outcome) {
        mode = outcome.mode;
        judged.forEach((x, i) => {
          const answer = choiceOf(outcome, `a_${i}`);
          if (answer) byApplication[key(x)] = judgmentFrom(answer, outcome.emulated);
        });
      }
    }
    if (!Object.keys(byApplication).length) return undefined;
    log.info(`[decision:${mode}] reviewer.patterns goal ${goalId.slice(0, 8)}: ${Object.entries(byApplication).map(([k, j]) => `${k}=${j.choice}@${fmtP(j.p)}`).join(' ')}`);
    return { mode, byApplication };
  }

  /**
   * Record assessments the review left missing from the judged verdicts
   * (site reviewer.predictions, act): confident ones as judged, the rest
   * unresolved with the probabilities that fell short. Each goes through
   * assess_prediction, so GoalManager's first-assessment lock holds and an
   * assessment already on record is never revised from here.
   */
  private async recordAutomatedAssessments(taskId: string, extra: ReviewTaskExtra, missing: Array<{ taskId: string; p: PredictionRecord }>): Promise<number> {
    const judged = extra.judgments?.predictions;
    if (!judged || judged.mode !== 'act' || !missing.length) return 0;
    extra.automatedAssessments = true;
    // Well inside the completion RPC deadline, alongside the batch's own actions.
    const deadline = Date.now() + 8000;
    let recorded = 0;
    for (const { taskId: episodeTask, p } of missing) {
      if (extra.cancelled || Date.now() >= deadline) break;
      const j = judged.byEpisode[`${episodeTask}:${p.step}`];
      if (!j) continue;
      const confident = j.p >= AUTO_ASSESS_MIN_P;
      const compared = `expected '${clipText(p.expect, 200)}' vs observed ${observedLine(p)}`;
      const explanation = confident
        ? `Automated assessment (${provenance(j)}): ${compared}`
        : `Automated assessment (decision model${j.emulated ? ', emulated' : ''}): insufficient for automated assessment (p_s=${fmtP(j.probabilities.supported ?? 0)}, p_c=${fmtP(j.probabilities.contradicted ?? 0)}); ${compared}`;
      const r = await this.applyReviewAction(taskId, { action: 'assess_prediction', taskId: episodeTask, step: p.step, verdict: confident ? j.choice : 'unresolved', explanation });
      if (r.success) recorded++;
    }
    log.info(`[decision:act] reviewer.predictions goal ${extra.goalId?.slice(0, 8) ?? '?'}: recorded ${recorded} of ${missing.length} missing assessments`);
    return recorded;
  }

  /** Record the judged summary-fidelity verdict when the review gave none (site reviewer.fidelity, act). */
  private async recordAutomatedFidelity(extra: ReviewTaskExtra): Promise<void> {
    const f = extra.judgments?.fidelity;
    if (!f || f.mode !== 'act' || extra.summaryFidelityRecorded || (!f.deterministic && f.p < AUTO_FIDELITY_MIN_P)) return;
    const explanation = f.deterministic
      ? 'Automated assessment (rule): no verification record or user-facing result to compare.'
      : `Automated assessment (${provenance(f)}; stale figure p=${fmtP(f.staleFigure)}, dropped caveat p=${fmtP(f.caveatDropped)}).`;
    await this.recordSummaryFidelity(extra, { verdict: f.verdict, explanation });
  }

  /**
   * Fill pattern applications the review left unassessed from confident
   * verdicts (site reviewer.patterns, act), through the journaled
   * record_pattern_application path. Applications without a recorded
   * application reference stay unassessed: they cannot be resolved here.
   */
  private async fillPatternApplications(taskId: string, extra: ReviewTaskExtra): Promise<void> {
    const judged = extra.judgments?.patterns;
    if (!judged || judged.mode !== 'act' || !extra.goalId || !this.goalManagerId || extra.cancelled) return;
    const effects: Array<Record<string, unknown>> = [];
    const refs = new Set<string>();
    for (const r of extra.records ?? []) for (const p of r.predictions ?? []) for (const a of p.patterns ?? []) {
      const key = `${r.taskId}:${p.step}:${a.id}`;
      const j = judged.byApplication[key];
      if (!j || !a.applicationRef || extra.applicationAssessments?.[key]) continue;
      if (!j.deterministic && j.p < AUTO_PATTERN_MIN_P) continue;
      const evidence = j.deterministic
        ? 'Automated assessment (rule): the step\'s outcome was not observed, so the effect of following the pattern stays inconclusive.'
        : `Automated assessment (${provenance(j)}): ${j.choice} (helpful ${fmtP(j.probabilities.helpful ?? 0)}, harmful ${fmtP(j.probabilities.harmful ?? 0)}, inconclusive ${fmtP(j.probabilities.inconclusive ?? 0)}).`;
      effects.push({ action: 'record_pattern_application', id: a.id, application: { taskId: r.taskId, step: p.step, context: clipText(a.why, 300), verdict: j.choice, evidence } });
      refs.add(`learning/task/${r.taskId}`);
    }
    if (!effects.length) return;
    try {
      await this.proposeLearning(taskId, effects.slice(0, MAX_FILLED_APPLICATIONS), { evidence: 'Automated pattern-application assessments (decision model)', evidenceRefs: [...refs] });
      log.info(`[decision:act] reviewer.patterns goal ${extra.goalId.slice(0, 8)}: filled ${Math.min(effects.length, MAX_FILLED_APPLICATIONS)} unassessed application(s)`);
    } catch (err) {
      log.warn(`Automated pattern assessments not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The judgments the reviewer model sees as priors (advise and act). Each
   * row is advisory; the reviewer's own reading of the evidence decides.
   */
  private renderPriors(worth?: WorthVerdict, judgments?: ReviewJudgments): string | undefined {
    const lines: string[] = [];
    let emulated = false;
    if (worth) {
      emulated ||= worth.emulated;
      lines.push(`- Learning value: level ${worth.level} of ${WORTH_LEVELS.length - 1} (${WORTH_LEVELS[worth.level] ?? '?'}), p=${fmtP(worth.levelP)}; owner evidence contradicting injected knowledge p=${fmtP(worth.conflict)}.`);
    }
    const f = judgments?.fidelity;
    if (f) {
      emulated ||= f.emulated;
      lines.push(f.deterministic
        ? '- Summary fidelity: unverifiable (no verification record or user-facing result to compare).'
        : `- Summary fidelity: ${f.verdict} p=${fmtP(f.p)} (a stale figure p=${fmtP(f.staleFigure)}, a dropped caveat p=${fmtP(f.caveatDropped)}).`);
    }
    const preds = judgments?.predictions;
    if (preds) {
      // Contradicted and least certain rows lead: they are where reading pays.
      const focus = (j: Judgment) => (j.choice === 'contradicted' ? 2 : 0) + (1 - j.p);
      const rows = Object.entries(preds.byEpisode).sort(([, a], [, b]) => focus(b) - focus(a)).map(([k, j]) => {
        emulated ||= j.emulated;
        return `  ${k.replace(/:(\d+)$/, ' step $1')}: ${j.choice} p=${fmtP(j.p)} (supported ${fmtP(j.probabilities.supported ?? 0)}, contradicted ${fmtP(j.probabilities.contradicted ?? 0)}, unresolved ${fmtP(j.probabilities.unresolved ?? 0)})`;
      });
      if (rows.length) lines.push(`- Predictions (contradicted and least certain first; a confident supported row needs only a confirming look):\n${rows.join('\n')}`);
    }
    const pats = judgments?.patterns;
    if (pats) {
      const rows = Object.entries(pats.byApplication).map(([k, j]) => {
        emulated ||= j.emulated;
        return `  ${k}: ${j.choice}${j.deterministic ? ' (outcome unobserved)' : ` p=${fmtP(j.p)}`}`;
      });
      if (rows.length) lines.push(`- Pattern applications (taskId:step:patternId):\n${rows.join('\n')}`);
    }
    if (!lines.length) return undefined;
    return `Automated priors (decision model${emulated ? ', emulated by a chat model' : ''}; advisory, nothing here is recorded; your reading of the evidence decides):\n${lines.join('\n')}`;
  }

  /**
   * Compare new entries with what the knowledge base already holds (site
   * reviewer.dedupe). Advise returns the verdict with the save; act turns a
   * confident duplicate away unless the item carries force: true. An entry
   * another author owns is never offered as an update target.
   */
  private async screenSaves(taskId: string, items: unknown[]): Promise<{ kept: unknown[]; notes: string[]; rejected: Array<{ item: Record<string, unknown>; message: string; duplicateOf: string }> }> {
    const out = { kept: [] as unknown[], notes: [] as string[], rejected: [] as Array<{ item: Record<string, unknown>; message: string; duplicateOf: string }> };
    for (const item of items) {
      const input = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
      if (!input || input.action !== 'save_entry') { out.kept.push(item); continue; }
      const { force, ...rest } = input;
      const verdict = await this.judgeDuplicate(taskId, rest).catch(() => undefined);
      if (verdict?.reject && force !== true) { out.rejected.push({ item: rest, message: verdict.reject, duplicateOf: verdict.duplicateOf! }); continue; }
      if (verdict?.note) out.notes.push(verdict.note);
      out.kept.push(force === undefined ? item : rest);
    }
    return out;
  }

  private async judgeDuplicate(taskId: string, input: Record<string, unknown>): Promise<{ note?: string; reject?: string; duplicateOf?: string } | undefined> {
    const title = typeof input.title === 'string' ? input.title : '';
    const content = typeof input.content === 'string' ? input.content : '';
    if (!title.trim() || !content.trim()) return undefined;
    if (await this.decisionSiteMode('reviewer.dedupe') === 'off') return undefined;
    const kb = await this.getKbId();
    if (!kb) return undefined;
    const extra = this.taskExtras.get(taskId);
    // Full entries (not previews): the author decides whether an update is on offer.
    const similar = await this.request<Array<{ id: string; title: string; type?: string; origin?: string; content?: string }>>(
      request(this.id, kb, 'recall', { query: `${title}\n${content.slice(0, 400)}`, limit: 6, scope: extra?.knowledgeScope }), 10000,
    ).catch(() => []);
    const candidates = (Array.isArray(similar) ? similar : []).filter(e => e?.id).slice(0, 6);
    if (!candidates.length) return undefined;
    const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : [];
    const outcome = await this.askDecision('reviewer.dedupe', boundDecisionState({
      new_entry: { title: clipText(title, 200), type: input.type ?? 'learned', tags, content: clipText(content, 1500) },
      existing: candidates.map((e, i) => ({ i, title: clipText(e.title, 200), type: e.type, origin: e.origin ?? 'agent', content: clipText(e.content ?? '', 500) })),
    }), dedupeQuestions(candidates.length), this.decisionScope(extra?.goalId, taskId));
    const relation = choiceOf(outcome, 'relation');
    if (!outcome || !relation) return undefined;
    const p = relation.probabilities[relation.choice] ?? 0;
    const kind = choiceOf(outcome, 'entry_kind');
    log.info(`[decision:${outcome.mode}] reviewer.dedupe "${clipText(title, 60)}": ${relation.choice}@${fmtP(p)} kind=${kind?.choice ?? '?'}`);
    const match = /^(duplicate_of|refines)_(\d+)$/.exec(relation.choice);
    const target = match ? candidates[Number(match[2])] : undefined;
    const origin = target?.origin ?? 'agent';
    const updatable = origin === 'agent' || origin === 'reviewer';
    const where = target ? `${target.id} ("${clipText(target.title, 80)}"; decision model${outcome.emulated ? ', emulated' : ''}, p=${fmtP(p)})` : '';
    let note: string | undefined;
    if (target && match![1] === 'duplicate_of') {
      note = updatable ? `Near-duplicate of ${where}; update_entry may fit better.` : `Near-duplicate of ${origin}-authored entry ${where}; that entry already holds this and stays as its author wrote it.`;
    } else if (target) {
      note = updatable ? `Refines ${where}; update_entry on it may fit better than a second entry.` : `Refines ${origin}-authored entry ${where}; it stays as its author wrote it, so a separate entry suits the refinement.`;
    }
    const kindP = kind ? kind.probabilities[kind.choice] ?? 0 : 0;
    const kindAdvice = kind && kindP >= 0.6 && ENTRY_KIND_ADVICE[kind.choice] && !(kind.choice === 'user_profile_fact' && tags.includes('profile'))
      ? `It reads as ${kind.choice.replace(/_/g, ' ')} (p=${fmtP(kindP)}): ${ENTRY_KIND_ADVICE[kind.choice]}.` : undefined;
    const turnedAway = outcome.mode === 'act' && !!target && p >= DEDUPE_ACT_P && (match![1] === 'duplicate_of' || updatable);
    if (turnedAway) {
      return { reject: `Not saved: ${[note, kindAdvice].filter(Boolean).join(' ')} To save it as a separate entry anyway, send it again with force: true.`, duplicateOf: target!.id };
    }
    const combined = [note, kindAdvice].filter(Boolean).join(' ');
    return combined ? { note: combined } : undefined;
  }

  /**
   * Does a reviewer-authored skill carry workspace-specific detail (site
   * reviewer.privacy, advise only)? A warning never blocks the install: it
   * rides with the proposal the user approves and with the tool result.
   */
  private async judgePrivacy(skill: { name: string; description: string; instructions: string }, scope: { goalId?: string; taskId?: string }): Promise<{ warning?: string; advice?: string } | undefined> {
    if (await this.decisionSiteMode('reviewer.privacy') === 'off') return undefined;
    const outcome = await this.askDecision('reviewer.privacy', boundDecisionState({
      skill: { name: skill.name, description: clipText(skill.description, 600), instructions: clipText(skill.instructions, 12000) },
    }), privacyQuestions(), this.decisionScope(scope.goalId, scope.taskId));
    const detail = noulOf(outcome, 'workspace_specific_detail');
    if (!outcome || detail === undefined) return undefined;
    const generic = noulOf(outcome, 'generic_multistep_procedure');
    const kind = choiceOf(outcome, 'detail_kind');
    log.info(`[decision:${outcome.mode}] reviewer.privacy skill "${skill.name}": workspace_specific_detail=${fmtP(detail)} kind=${kind?.choice ?? '?'} generic=${fmtP(generic)}`);
    const tag = `decision model${outcome.emulated ? ', emulated' : ''}`;
    const warning = detail >= PRIVACY_WARN_P
      ? `Review before enabling: this skill may carry workspace-specific detail (${DETAIL_KINDS[kind?.choice ?? ''] ?? DETAIL_KINDS.other_detail}; ${tag}, p=${fmtP(detail)}).`
      : undefined;
    const advice = generic !== undefined && generic < 0.3
      ? `It reads less like a reusable multi-step procedure (${tag}, p=${fmtP(generic)}); a knowledge entry may suit it better.`
      : undefined;
    return warning || advice ? { warning, advice } : undefined;
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
  private async buildLearningDossier(task: string, material: string, records: TranscriptResponse[], knowledgeRefs: Record<string, string> = {}, priors?: string): Promise<string> {
    const pieces: string[] = [];
    let remaining = GOAL_TRANSCRIPT_BUDGET;
    const append = (text: string, cap: number): void => {
      const limit = Math.min(cap, remaining);
      if (limit <= 0) return;
      const part = text.length > limit ? `${text.slice(0, Math.max(0, limit - 100))}\n[Briefing excerpt; use read_evidence for complete material.]` : text;
      pieces.push(part); remaining -= part.length + 2;
    };
    append(`Learning dossier: ${records.length} task records. Task success is not prediction accuracy. Missing predictions are unknown, not confirmations.\nUse read_evidence with taskId and optional step for observations, key for learning/plans or learning/observation/<operationId>, or offset/length for complete material.`, 1000);
    append(records.map(r => `${r.taskId}: ${r.agentName}, outcome=${r.phase}; scopes=${JSON.stringify(r.knowledgeScopes ?? (r.knowledgeScope ? [r.knowledgeScope] : []))}; observation steps=[${(r.predictions ?? []).map(p => p.step).join(',')}]. Every listed step needs an assessment or an explicit evidence gap.`).join('\n'), 6000);
    // Owner-provided completion evidence includes checks that ran before the
    // first model action. They can disprove recalled claims about capabilities.
    const outcomeBudget = Math.floor(3600 / Math.max(1, records.length));
    append('Task completion evidence:\n' + records.map(r => {
      const outcome = typeof r.result === 'string' ? r.result : JSON.stringify(r.result) ?? r.error ?? '(none)';
      const excerpt = outcome.length <= outcomeBudget ? outcome
        : `${outcome.slice(0, outcomeBudget / 2)}\n[... outcome excerpt; read_evidence for full result ...]\n${outcome.slice(-outcomeBudget / 2)}`;
      return `${r.taskId}: ${excerpt}`;
    }).join('\n'), 4200);
    // Index surprises across ALL tasks, including tasks omitted from transcript excerpts.
    const predictions = records.flatMap(r => (r.predictions ?? []).map(p => ({ r, p })));
    append('Declared pattern applications (seeing a pattern does not establish its usefulness):\n' + predictions.flatMap(({ r, p }) =>
      (p.patterns ?? []).map(pattern => `${r.taskId} step ${p.step}: ${pattern.id}; ${pattern.why ?? ''}`)).join('\n'), 2500);
    predictions.sort((a, b) => Number(b.p.verdict === 'contradicted') - Number(a.p.verdict === 'contradicted'));
    const rowBudget = Math.floor(15500 / Math.max(1, predictions.length));
    const detailsBudget = Math.max(0, rowBudget - 180);
    append(`Prediction/feedback index (${predictions.length} observations; excerpts are not complete evidence):\n` + predictions.map(({ r, p }) =>
      `${r.taskId} step ${p.step}: operation=${p.outcome}, status comparison=${p.verdict ?? 'unresolved'}; expected=${(p.expect || '(missing)').slice(0, detailsBudget / 2)}; actual excerpt=${(typeof p.actual === 'string' ? p.actual : JSON.stringify(p.actual) ?? '(no observation)').slice(0, detailsBudget / 2)}`).join('\n'), 16000);
    // Decision-model priors (advise/act) sit beside the index they annotate.
    if (priors) append(priors, 3500);
    const kb = await this.getKbId();
    if (kb) {
      const recalled = await this.request<Array<{ id: string; title: string; snippet?: string }>>(request(this.id, kb, 'recall', { query: task, limit: 6, previews: true, scope: this.reviewScope(records) })).catch(() => []);
      const injected = records.flatMap(r => (r.injectedKnowledge ?? []).map(k => ({ ...k, taskId: r.taskId })));
      // Relevant claims and declared applications precede always-injected
      // profile facts. Legacy snapshots have no source; rank their recalled
      // matches first rather than letting profile order consume the budget.
      const ids = [...new Set([
        ...injected.filter(k => k.source === 'relevant').map(k => k.id),
        ...predictions.flatMap(({ p }) => (p.patterns ?? []).map(p => p.id)),
        ...recalled.map(k => k.id),
        ...injected.filter(k => k.source !== 'profile').map(k => k.id),
        ...injected.map(k => k.id),
      ])].slice(0, 12);
      const entries = await Promise.all(ids.map(id => this.request(request(this.id, kb, 'get', { id })).catch(() => null)));
      append('Knowledge reconciliation: use explicit parent evidenceRefs such as learning/task/<taskId>, learning/observation/<taskId>:<step>, learning/assessment/<taskId>:<step>. Put shared evidence and evidenceRefs alongside knowledgeUpdates in done.result; archive items inherit this shared context. Effects can update_entry, archive_entry (global only), supersede_entry (replacementId, optional scope), dispute_entry, narrow_entry (scope), confirm_entry, save_entry, or no_change. A single learn action uses {context:{evidence,evidenceRefs,scope},effects:[...]}. Connect interpretation to the affected claim; no_change and uncertainty are valid. Compare historical claims with observed actions and completion evidence. Correct obsolete claims even when the task succeeded and no pattern was applied. Injection does not prove usefulness. Excerpts are bounded; use recall by id before replacing a partially shown entry.', 600);
      const perEntry = Math.floor(8400 / Math.max(1, ids.length));
      for (let i = 0; i < ids.length; i++) {
        const selected = injected.filter(k => k.id === ids[i]);
        const current = entries[i] as { title?: string; type?: string; content?: string; knowledgeRef?: string } | null;
        if (current?.knowledgeRef) knowledgeRefs[ids[i]] = current.knowledgeRef;
        const claimBudget = Math.max(80, Math.floor((perEntry - 220) / 2));
        append(JSON.stringify({ id: ids[i], title: current?.title ?? selected[0]?.title,
          injectedIn: selected.map(k => k.taskId), selectedRefs: selected.map(k => k.knowledgeRef ?? null), knowledgeRef: current?.knowledgeRef,
          shownClaim: selected[0]?.content?.slice(0, claimBudget) ?? '(legacy snapshot: claim text not captured)',
          currentClaim: current?.content?.slice(0, claimBudget) ?? '(unavailable)', claimLength: current?.content?.length, excerpt: (current?.content?.length ?? 0) > claimBudget, type: current?.type,
        }), perEntry);
      }
    }
    // After the evidence index and existing model, spend the remainder on execution context.
    append(material, remaining);
    return pieces.join('\n\n');
  }

  private reviewScope(records: TranscriptResponse[]): string | undefined {
    const scopes = [...new Set(records.flatMap(r => r.knowledgeScopes ?? (r.knowledgeScope ? [r.knowledgeScope] : [])))];
    return scopes.length === 1 ? scopes[0] : undefined;
  }

  private async launchReview(task: string, material: string, reviewedTaskIds: string[], goalId?: string, records: TranscriptResponse[] = [],
    decisions: { worth?: WorthVerdict; judgments?: ReviewJudgments } = {}): Promise<void> {
    const taskId = `review-${goalId ?? 'standalone'}-${Date.now()}`;
    this.inFlight = { ticketId: taskId, startedAt: Date.now() };
    const knowledgeScope = this.reviewScope(records);
    this.taskExtras.set(taskId, { kind: 'review', reviewedTaskIds, goalId, records, fullMaterial: material, knowledgeScope,
      ...(decisions.judgments ? { judgments: decisions.judgments } : {}) });
    const refs: Record<string, string> = {};
    const dossier = await this.buildLearningDossier(task, material, records, refs, this.renderPriors(decisions.worth, decisions.judgments));
    this.taskExtras.get(taskId)!.knowledgeRefs = refs;
    try {
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId, task,
          systemPrompt: this.reviewSystemPrompt(),
          initialMessages: [{ role: 'user', content: dossier }],
          config: { maxSteps: 8, timeout: 180000, budgetGoalId: goalId, knowledgeScope },
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

    if (!['assess_prediction', 'read_evidence'].includes(action.action) && !(await this.getKbId())) {
      return { success: false, error: 'KnowledgeBase not available' };
    }
    if (extra.cancelled) return { success: false, error: 'Review cancelled' };

    try {
      if (['record_pattern_application', 'update_pattern', 'mark_useful'].includes(action.action)) await this.requireLearningProtocol();
      let result: string;
      switch (action.action) {
        case 'assess_prediction': {
          if (!extra.goalId || !this.goalManagerId) throw new Error('A goal review is required to record an assessment');
          if (!extra.records?.some(r => r.taskId === action.taskId && r.predictions?.some(p => p.step === action.step))) throw new Error('Assessment is outside this review evidence');
          const decision = await this.request<{ success: boolean; error?: string; assessment?: { verdict: string; explanation?: string } }>(request(this.id, this.goalManagerId, 'recordPredictionAssessment', {
            goalId: extra.goalId, taskId: action.taskId, step: action.step, verdict: action.verdict, explanation: action.explanation, expectedRevision: action.expectedRevision, evidenceRefs: action.evidenceRefs,
          }), 5000);
          if (!decision.success) throw new Error(decision.error ?? 'Assessment rejected');
          if (decision.assessment) (extra.assessments ??= {})[`${action.taskId}:${action.step}`] = decision.assessment;
          result = JSON.stringify(decision);
          break;
        }
        case 'read_evidence': {
          let text = extra.fullMaterial ?? '';
          if (action.context === true) {
            // Reviews have a budgetGoalId, not an active execution goal. Keep
            // context reads scoped here; GoalManager owns reference validation.
            if (!extra.goalId || !this.goalManagerId) throw new Error('This review has no goal context');
            if (action.taskId !== undefined || action.step !== undefined) throw new Error('Read context and task evidence separately');
            text = JSON.stringify(await this.request(request(this.id, this.goalManagerId, 'readGoalContext', {
              goalId: extra.goalId, messageId: action.messageId, sourceGoalId: action.sourceGoalId, key: action.key,
            }))) ?? 'null';
          } else if (typeof action.key === 'string') {
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
            request(this.id, this.knowledgeBaseId!, 'recall', { query, limit: 6, previews: true, scope: extra.knowledgeScope }),
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
          if (extra.cancelled) return { success: false, error: 'Review cancelled' };
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
          if (extra.cancelled) return { success: false, error: 'Review cancelled' };
          const decision = await this.request<{ success: boolean; archived?: boolean; deleted?: boolean; error?: string }>(request(this.id, this.knowledgeBaseId!, 'forget', { id }), 10000);
          if (!decision?.success) throw new Error(decision?.error ?? 'forget failed');
          result = decision.deleted ? `Deleted ${id} (it was already archived)` : `Forgot ${id}: archived, restorable`;
          break;
        }

        case 'archive_entry': {
          const id = action.id as string;
          if (!id) return { success: false, error: 'archive_entry requires "id"' };
          const guard = await this.guardCuratable(id, 'archive');
          if (guard) return { success: false, error: guard };
          if (extra.cancelled) return { success: false, error: 'Review cancelled' };
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
            }), 5000);
          } else if (Number.isSafeInteger(applied.revision) && applied.revision! > 0) {
            // Historical evidence can contain an explicit captured revision.
            // Never substitute today's revision for missing provenance.
            res = await this.request(request(this.id, this.knowledgeBaseId!, 'recordPatternApplication', {
              id: action.id, application: { id: `${extra.goalId}:${action.id}:${observedTaskId}:${step}`, goalId: extra.goalId,
                context: application.context, evidence: application.evidence, verdict: application.verdict, patternRevision: applied.revision },
            }), 5000);
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
          result = await this.authorSkill(action, { goalId: extra.goalId, taskId });
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
  private async authorSkill(action: AgentAction, scope: { goalId?: string; taskId?: string } = {}): Promise<string> {
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

    // Skills travel beyond this workspace. A judged risk of workspace-specific
    // detail rides with the proposal: in the description the user reads
    // before enabling, and as a review-warning field (site reviewer.privacy).
    const privacy = await this.judgePrivacy({ name, description, instructions }, scope).catch(() => undefined);
    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(privacy?.warning ? `${description} [${privacy.warning}]` : description)}`,
      'origin: reviewer',
      ...(privacy?.warning ? [`review-warning: ${JSON.stringify(privacy.warning)}`] : []),
      '---',
      '',
      instructions.trim(),
      '',
    ].join('\n');

    await this.request(
      request(this.id, this.skillRegistryId!, 'installSkill', { name, content }),
      15000,
    );
    const installed = wasEnabled
      ? `Updated skill "${name}" and disabled it pending the user's re-approval in Settings`
      : `Authored skill "${name}" (installed disabled; the user can enable it in Settings)`;
    return [
      installed,
      privacy?.warning ? `A warning is attached for the user's approval: ${privacy.warning} Keep skills generic; personal and workspace details belong in save_entry, and author_skill again with a generic version replaces this one.` : '',
      privacy?.advice ?? '',
    ].filter(Boolean).join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Prompts
  // ═══════════════════════════════════════════════════════════════════

  private reviewSystemPrompt(): string {
    return `You are a post-task reviewer. Work in this workspace just finished: either a goal (with the transcripts of every task that ran under it, across one or more agents) or a single standalone task. The conversation above contains the material: the outcome, each task's transcript, and the knowledge entries that were injected into each agent's prompt. Your job is to grow the workspace's long-term memory from this experience, then finish. The doing is over; you only distill.

Permission and environment claims require owner evidence. Compare recorded execution provider/transport/contextVersion with capability permission receipts. A provider sandbox restriction is not an Abject denial. Worker narratives alone do not establish unavailable access. Read referenced observations when needed; leave unsupported claims unresolved, and correct stale knowledge when owner evidence contradicts it.

Assess each prediction and pattern against its observed episode. A failed goal can contain useful approaches, and a successful goal can contain false predictions. Separate local evidence from the overall outcome.

The observation-step manifest lists the complete assessment coverage. Do not infer agreement from a truncated excerpt. Read full evidence when an excerpt cannot establish the comparison, especially final verification and commit outcomes. Record supported, contradicted, or unresolved with an explanation for every listed step. The runtime may request one targeted correction for omissions.

## Interpret operation results before judging predictions
Assess the exact prediction made before the action, using the operation's actual arguments, output, and observed effects. The runtime's success/failure and status-comparison verdict are raw execution evidence, not your semantic assessment. Preserve those observations; do not rewrite an exit code to make it agree with your judgment.

An exit status has meaning within a particular command or protocol. For example, git diff --no-index returns 1 when it finds differences: a returned patch can support "the differences will be available", while contradicting "these files are identical" or "this command will exit 0". A search returning 1 with no matches can support "there are no matching records" if the intended scope was searched successfully; an unreadable input or invalid expression does not establish absence. Expected validation rejection can support a prediction when the rejection and absence of side effects are observed. Conversely, exit 0 with skipped items, partial results, or the wrong artifact does not support a claim of complete execution.

Read the command or requested method and its evidence with read_evidence when the index omits them. Do not infer the semantics of an unfamiliar status, a truncated result, or a compound command from its final exit alone. A later successful command or pipeline stage may hide an earlier failure. Explain which part of the recorded expectation the output supports or contradicts. A compound prediction is supported only when its material claims are supported; a disproved material claim is contradicted, and a missing material observation is unresolved when nothing disproves it. If the operation's meaning or result coverage cannot be established from the available evidence, record unresolved with the specific gap rather than guessing. Ground any resulting knowledge correction in this semantic comparison, not merely in the runtime's status label.

When the dossier carries automated priors from a decision model, read them as a second reader's notes: a confident supported episode needs only a confirming look, so spend read_evidence on the contradicted and uncertain ones. Your recorded assessment rests on the evidence you read; a prior is a place to start looking.

For execution of an accepted proposal, compare the observed artifact or effect with the actual accepted selection, grouping, and wording, including omissions and additions. Use read_evidence with context:true to find the reviewed goal's conversation references, then context:true with messageId or sourceGoalId and optional key to retrieve the proposal. Read only the missing evidence; do not rerun the work. Git staging exit 0, diff statistics, and git diff --check do not prove that approved hunks landed in the intended commit. Compare full staged/committed evidence with the intended selection; if that evidence is unavailable, mark the substantive claim unresolved rather than supported. Combined-tree verification does not prove every intermediate commit was verified. Assess whether repeated inspections were justified by changed inputs or missing details before crediting a reuse pattern. Record counterexamples only for patterns actually declared, and keep specific proposal contents on the goal scratchpad.

Before superseding a claim, reconcile the replacement too. A promising title or excerpt is insufficient: recall by id to read its complete current content. If it is stale, update it in the same learning decision before supersession. If it is already accurate, provide replacementEvidence explaining how its current claims agree with recorded episode evidence; the runtime captures its selected version. Alternatively, confirm_entry in the same decision records this evidence-backed confirmation. Do not invent version numbers. A no_change with a reason or an explicit dispute is valid when replacement accuracy remains uncertain. Use the recorded project scope; multi-project evidence must not be assigned a guessed common scope.

## Output Format
Respond with ONE JSON action object inside \`\`\`json fenced code markers. Output ONLY the JSON block; put any brief note in the action's "reasoning" field.

## Actions
| Action | Fields | Purpose |
|--------|--------|---------|
| mark_useful | ids | Credit the injected entries that genuinely influenced the work |
| assess_prediction | taskId, step, verdict, explanation | Record supported/contradicted/unresolved semantic assessment with an evidence-grounded explanation, separately from observations |
| read_evidence | taskId?, step?, key?, context?, messageId?, sourceGoalId?, offset?, length? | Retrieve complete task evidence or a prediction/observation pair; context:true reads the reviewed goal's linked conversation/proposal through GoalManager, separately from taskId/step |
| recall_knowledge | query | Check what the knowledge base already holds before saving |
| save_entry | title, content, type?, tags? | Save one durable lesson (type: 'learned'\|'fact'\|'insight'\|'reference') |
| update_entry | id, content?, title?, tags? | Refresh an existing entry instead of near-duplicating it |
| forget_entry | id | Remove an entry this transcript proves wrong |
| record_pattern_application | id, application | Record context, verdict (applied/helpful/harmful/inconclusive), evidence, and taskId/step for this goal; the runtime resolves the applied version; repeated delivery is deduplicated |
| save_pattern | name, context, forces, therefore, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, links?, tags? | Add a pattern to the workspace's pattern language |
| update_pattern | id, context?, forces?, therefore?, evidence?, aliases?, problem?, contract?, program?, resultingContext?, consequences?, appliesTo?, addLinks? | Strengthen an existing pattern; only the sections you supply change |
| author_skill | name, description, instructions | Package a reusable multi-step procedure as a skill |
| done | result: {assessments, applications, knowledgeUpdates?, summary?, unresolvedReason?} | Submit assessments and knowledge corrections together; receiver messages record them without a separate LLM turn per item |
| fail | reason | The material was unreviewable |

## Connected learning
For knowledge changes, use done.result with shared evidence, evidenceRefs, and knowledgeUpdates. Evidence refs identify recorded learning/task/<taskId>, learning/observation/<taskId>:<step>, or learning/assessment/<taskId>:<step> values. Example:
{"action":"done","result":{"evidence":"Owner verification on this project revision ran 198 tests successfully","evidenceRefs":["learning/task/<observed task>"],"knowledgeUpdates":[{"action":"update_entry","id":"<canonical>","content":"Corrected claim, preserving other valid content"},{"action":"supersede_entry","id":"<duplicate>","replacementId":"<canonical>","scope":"project:abject"}]}}
A single learn action uses {context:{evidence,evidenceRefs,scope},effects:[...]}. To fix an existing rejected effect within this review, use repair_learning with decisionId, effectId and input containing the revised action. Do not submit a new unrelated decision to replace a pending effect. Individual save_entry/update_entry/save_pattern/update_pattern actions also take evidence and evidenceRefs. The runtime supplies IDs and selection references. Dispositions include confirm_entry, dispute_entry, narrow_entry (scope), supersede_entry (replacementId and scope), archive_entry (global retirement), and no_change (reason in evidence). Do not turn a project-specific observation into a global archive. Pattern applications connect automatically to their recorded task/step; do not supply revision numbers. Missing evidence stays pending. One focused repair can correct a rejected item; it never repeats the whole retrospective.
A retained full output and an inline preview are different deliveries. A short preview alone does not contradict a prediction that the full result will be available. A successful process, correct delivery, domain success and semantic agreement are separate questions.

## Completion example
After inspecting the evidence, submit assessments directly in the final result:
{"action":"done","result":{"assessments":[{"taskId":"<observed task>","step":1,"verdict":"contradicted","explanation":"Expected no test suite, but the owner verification ran 198 tests successfully."}],"applications":[{"id":"<applied pattern>","application":{"taskId":"<observed task>","step":1,"context":"Inspecting changes","verdict":"inconclusive","evidence":"Whether the agent used this pattern is recorded; its benefit remains uncertain."}}],"summary":"One prediction contradicted; no generalization beyond the observed project inputs."}}
Use real task/step identities from the dossier. Cover the recorded predictions, including supported expectations, contradictions, and unresolved claims with specific evidence gaps. Use read_evidence for missing context; hidden payload bodies and an agent's assertion that it reviewed them are not evidence of inspection. Never infer that every prediction held just because every command exited zero. Pattern applications require recorded provenance; seeing an injected pattern does not prove it was used. You may omit applications when none were declared. Existing knowledge corrections can share the completion: knowledgeUpdates:[{action:"update_entry",id:"<existing entry>",title:"<accurate title>",content:"<corrected scoped claim and evidence>",evidence:"<observed task/step or owner verification result>"}]. archive_entry is also supported for obsolete duplicates. New lessons and all existing learning actions remain available individually. Rejected corrections remain visible as partial learning; do not loop to force acceptance.

## How to review
1. **Evaluate predictions first.** Compare the expected claim with the actual result, and include the assessment in the completion batch. Then consider knowledge usefulness. Compare the injected knowledge list against the transcript: entries that demonstrably helped the outcome get one mark_useful call with their ids; mere retrieval or use is not benefit. When none were used, omit usefulness credit; still assess the recorded predictions.
2. **Mine the prediction misses.** A prediction ledger, when present, lists what each agent expected before acting beside what actually happened. A divergence marks the exact moment a working belief about this system turned out to be wrong, which makes it the most reliable lesson source in the whole record: trust it ahead of anything an agent narrated about its own performance. Runtime verdicts compare declared operation status; they do not assess the free-text expectation. A failed action can be the expected result. Legacy missed flags are not proof. Distinguish an invalid pattern from incorrect application, changed conditions, and an execution defect. Preserve competing explanations and scope any revision to the evidence. Distinguish uncertainty from contradiction; for the rest, judge the expectation against the actual result yourself, since an agent can succeed at an action and still have expected the wrong thing. Save the corrected belief, phrased as what actually holds and what to do with it, rather than the incident that revealed it. Record semantic assessments with assess_prediction. Successful actions alone do not establish that predictions held.
3. **Distill sparingly.** New reusable lessons are optional. A routine task can finish with no new lesson after recording its prediction assessments; an empty learning update list does not replace those assessments. Save a lesson only when it will help a later task in the applicable project or environment: a capability that was hard to locate, an approach that beat the obvious one (with the reason), a constraint that was invisible up front, or a user fact the task confirmed (tag user facts "profile").

   **Save what is true, not the route that was taken.** An entry that tells a future task which steps to run for a kind of question — look here, then check that — freezes one attempt's path as though it described the world, and the next task follows it rather than working out its own. The risk runs opposite to confidence: a task that answered the wrong question without friction yields the tidiest-looking procedure for answering it wrongly again, and writing that down is how a single wrong turn becomes the route everyone takes. Before saving steps, check the transcript against what was actually asked — a fulfilled prediction only shows the agent did what it predicted, not that the user's question was answered, so an entry resting on assessments alone rests on nothing. Record what a thing is, what it exposes, and what its output means; leave the steps to the task.
4. **Reconcile existing knowledge with the world.** Compare the claims injected into agents with current observations, including owner-reported checks that ran before the first model action. A successful task can disprove old claims such as a command, test suite, or capability being unavailable. This matters even when no pattern was declared. Correct the existing entry's title AND content, preserving scope, observation date, and evidence; archive obsolete duplicates rather than adding a competing correction alongside them. Do not erase unrelated valid content. Fetch the full entry with recall by id before replacing an excerpt. Current entries may already be corrected: compare them with the historical claim and leave accurate revisions alone. Missing or ambiguous evidence means uncertainty, not an automatic rewrite. Prefetched entries satisfy recall only for the material shown.
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

Finish when the evidence supports the learning updates; do not invent an update just to make one.

## Summary fidelity
The user-facing result is a claim; the verification record is evidence. Compare them: every figure about checks or tests in the result must match the NEWEST recorded run, and caveats a task reported (what it did not cover or verify) must survive into the result. Include \`summaryFidelity: { verdict: "consistent" | "misreported" | "unverifiable", explanation }\` in your done result: misreported when the result quotes a figure or claim the record contradicts or does not support, unverifiable when there is no record to compare against. Name the specific figure or claim in the explanation.`;
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
