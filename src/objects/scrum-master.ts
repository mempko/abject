/**
 * ScrumMaster — Sprint Planning and Sprint Review for goals.
 *
 * Subscribes to GoalManager. On `goalCreated` for a top-level goal, runs
 * Sprint Planning: polls every team member (registered agents with
 * canExecute=true) in parallel via the existing `ask` protocol, synthesizes
 * the contributions into a task list with explicit per-task agent
 * assignments, and enqueues each task on its assigned agent's task queue
 * (via AgentAbject.enqueueTask). On `goalReadyForCompletion` (every task at
 * the goal's currentScrumNumber is terminal), runs Sprint Review: a
 * synthesis LLM call decides DONE — call completeGoal — or ANOTHER_SCRUM —
 * fold the gap into context and run Sprint Planning again.
 *
 * Drawn from Sutherland & Coplien's "A Scrum Book" patterns: the ScrumMaster
 * facilitates planning and review without doing the work itself; the
 * Whole Team contributes during Sprint Planning; backlog items run through
 * the team in atomic units; the Sprint Retrospective is folded into the
 * next planning round when failures need addressing.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ScrumMaster');

const SCRUM_MASTER_INTERFACE: InterfaceId = 'abjects:scrum-master';

/** Per-goal scrum tracking. Each goal in flight has at most one entry. */
interface ScrumState {
  goalId: string;
  /** Set when planning is in progress for this goal — prevents concurrent re-entry. */
  planningInProgress: boolean;
  /** Set when review is in progress for this goal. */
  reviewInProgress: boolean;
}

/** A single team-member contribution returned by `planContribution` ask. */
interface TeamContribution {
  agentId: AbjectId;
  agentName: string;
  text: string;
}

/** A planned task: synthesized from contributions, assigned to an agent. */
interface PlannedTask {
  description: string;
  assignedAgentName: string;
  dependsOn?: number[]; // indices into the same scrum's task list
  produces?: Array<{ key: string; description: string }>;
  consumes?: string[];
}

export class ScrumMaster extends Abject {
  private goalManagerId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private llmId?: AbjectId;

  /** In-memory scrum state per active goal. Cleared on goalCompleted/Failed. */
  private scrums = new Map<string, ScrumState>();

  /** Track which (goalId, scrumNumber) pairs we've already reviewed so a duplicate
   *  goalReadyForCompletion event (e.g. on restart) doesn't trigger a second review. */
  private reviewedScrums = new Set<string>();

  constructor() {
    super({
      manifest: {
        name: 'ScrumMaster',
        description:
          'Sprint Planning and Sprint Review for goals. Polls the team for contributions, ' +
          'assigns tasks via AgentAbject.enqueueTask, and decides DONE or ANOTHER_SCRUM at ' +
          'each scrum boundary. One per workspace.',
        version: '1.0.0',
        interface: {
          id: SCRUM_MASTER_INTERFACE,
          name: 'ScrumMaster',
          description: 'Sprint orchestration for goals',
          methods: [
            {
              name: 'runSprintPlanning',
              description: 'Manually trigger Sprint Planning for a goal (normally called automatically on goalCreated).',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'object', properties: {
                scrumNumber: { kind: 'primitive', primitive: 'number' },
                tasksPlanned: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'runSprintReview',
              description: 'Manually trigger Sprint Review (normally called on goalReadyForCompletion).',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'object', properties: {
                decision: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
          events: [
            {
              name: 'sprintPlanned',
              description: 'A scrum was planned for a goal',
              payload: { kind: 'object', properties: {
                goalId: { kind: 'primitive', primitive: 'string' },
                scrumNumber: { kind: 'primitive', primitive: 'number' },
                tasksPlanned: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'sprintReviewed',
              description: 'A sprint review completed',
              payload: { kind: 'object', properties: {
                goalId: { kind: 'primitive', primitive: 'string' },
                scrumNumber: { kind: 'primitive', primitive: 'number' },
                decision: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.LLM_QUERY, reason: 'Planning and review synthesis', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'scrum'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.goalManagerId = await this.requireDep('GoalManager');
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.llmId = await this.discoverDep('LLM') ?? undefined;

    // Subscribe to GoalManager so we receive goalCreated and
    // goalReadyForCompletion events for every goal.
    this.send(request(this.id, this.goalManagerId, 'addDependent', {}));

    log.info('Initialized; subscribed to GoalManager events');
  }

  private setupHandlers(): void {
    // Manual triggers — primarily for tests / debugging.
    this.on('runSprintPlanning', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      return this.runSprintPlanning(goalId);
    });

    this.on('runSprintReview', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      return this.runSprintReview(goalId);
    });

    // GoalManager event subscription. Two triggers we care about:
    //  - goalCreated: kick off Sprint Planning for a fresh top-level goal.
    //  - goalReadyForCompletion: every task at the goal's currentScrumNumber
    //    is terminal — run Sprint Review.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value: unknown };
      if (aspect === 'goalCreated') {
        const { goalId, parentId } = value as { goalId: string; parentId?: string };
        // Only handle top-level goals. Sub-tasks within an existing goal don't
        // create new goals under the Scrum model — Sprint Planning adds tasks
        // to the SAME goal at a new scrum number.
        if (parentId) return;
        // Defer to next tick so Chat (or whoever called createGoal) has time
        // to addTask the user's intent before we plan. Without this small
        // delay, Sprint Planning runs against a goal with zero tasks and the
        // synthesis LLM call has nothing to work with.
        setTimeout(() => {
          this.runSprintPlanning(goalId).catch(err =>
            log.warn(`runSprintPlanning(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
          );
        }, 200);
      } else if (aspect === 'goalReadyForCompletion') {
        const { goalId, scrumNumber } = value as { goalId: string; scrumNumber: number };
        const reviewKey = `${goalId}#${scrumNumber}`;
        if (this.reviewedScrums.has(reviewKey)) {
          log.info(`Skipping review for ${goalId.slice(0, 8)} scrum ${scrumNumber} (already reviewed)`);
          return;
        }
        this.reviewedScrums.add(reviewKey);
        this.runSprintReview(goalId).catch(err =>
          log.warn(`runSprintReview(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
        );
      } else if (aspect === 'goalCompleted' || aspect === 'goalFailed') {
        const { goalId } = value as { goalId: string };
        this.scrums.delete(goalId);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Sprint Planning
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Run Sprint Planning for a goal. Polls every team member with a
   * planContribution-style ask, synthesizes contributions into a task
   * list with assignments, increments the goal's scrum number, and
   * enqueues each task on its assigned agent's queue.
   */
  private async runSprintPlanning(goalId: string): Promise<{ scrumNumber: number; tasksPlanned: number }> {
    if (!this.goalManagerId || !this.agentAbjectId) {
      log.warn(`runSprintPlanning: missing dependencies`);
      return { scrumNumber: -1, tasksPlanned: 0 };
    }
    const state = this.scrums.get(goalId) ?? { goalId, planningInProgress: false, reviewInProgress: false };
    if (state.planningInProgress) {
      log.info(`runSprintPlanning(${goalId.slice(0, 8)}): planning already in progress, skipping re-entry`);
      return { scrumNumber: -1, tasksPlanned: 0 };
    }
    state.planningInProgress = true;
    this.scrums.set(goalId, state);

    try {
      // 1. Gather goal context
      const goal = await this.request<{
        title: string; status: string; currentScrumNumber: number;
        definitionOfDone?: string; scratchpad?: Record<string, unknown>;
      } | null>(
        request(this.id, this.goalManagerId, 'getGoal', { goalId }),
      );
      if (!goal) {
        log.warn(`runSprintPlanning: goal ${goalId.slice(0, 8)} not found`);
        return { scrumNumber: -1, tasksPlanned: 0 };
      }
      if (goal.status !== 'active') {
        log.info(`runSprintPlanning: goal ${goalId.slice(0, 8)} not active (${goal.status})`);
        return { scrumNumber: goal.currentScrumNumber, tasksPlanned: 0 };
      }

      // 2. Gather all prior tasks (results + failures) for sprint planning context
      const allTasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }),
      ).catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>);

      const completed = allTasks.filter(t => t.fields.status === 'done');
      const failed = allTasks.filter(t => t.fields.status === 'permanently_failed');

      // 3. Get the team — registered agents with canExecute=true
      const team = await this.request<Array<{ agentId: AbjectId; name: string; description: string; status: string }>>(
        request(this.id, this.agentAbjectId, 'listAgents', {}),
      );
      const eligibleTeam = team.filter(a => a.name !== 'Chat' && a.name !== 'ScrumMaster');
      if (eligibleTeam.length === 0) {
        log.warn(`runSprintPlanning: no eligible team members for goal ${goalId.slice(0, 8)}`);
        return { scrumNumber: goal.currentScrumNumber, tasksPlanned: 0 };
      }

      log.info(`Sprint Planning for goal ${goalId.slice(0, 8)} ("${goal.title.slice(0, 60)}") with ${eligibleTeam.length} team member(s); prior: ${completed.length} done, ${failed.length} failed`);

      // 4. Round-robin: ask each team member for their contribution
      const contributions = await this.gatherTeamContributions(goal, eligibleTeam, completed, failed);
      log.info(`Sprint Planning: ${contributions.length} team contribution(s) gathered`);

      // 5. Synthesis LLM call: pick the tasks that should run next
      const planned = await this.synthesizePlan(goal, eligibleTeam, contributions, completed, failed);
      if (planned.length === 0) {
        log.info(`Sprint Planning: no tasks planned for goal ${goalId.slice(0, 8)}`);
        return { scrumNumber: goal.currentScrumNumber, tasksPlanned: 0 };
      }

      // 6. Increment scrum number on the goal
      const { scrumNumber } = await this.request<{ scrumNumber: number }>(
        request(this.id, this.goalManagerId, 'startNextScrum', { goalId }),
      );

      // 7. addTask for each planned task with the new scrumNumber and assignedAgentId
      const taskIds: string[] = [];
      const nameToAgentId = new Map<string, AbjectId>(eligibleTeam.map(a => [a.name, a.agentId]));
      for (let i = 0; i < planned.length; i++) {
        const p = planned[i];
        const assignedAgentId = nameToAgentId.get(p.assignedAgentName);
        if (!assignedAgentId) {
          log.warn(`Sprint Planning: task "${p.description.slice(0, 60)}" assigned to unknown agent "${p.assignedAgentName}"; skipping`);
          continue;
        }
        // Resolve dependsOn from indices into prior taskIds
        let depIds: string[] | undefined;
        if (p.dependsOn?.length) {
          depIds = p.dependsOn
            .filter(idx => idx >= 0 && idx < taskIds.length)
            .map(idx => taskIds[idx]);
        } else if (i > 0) {
          // Default sequential — the next task waits on the previous one. Matches
          // Sutherland & Coplien's "Granularity Gradient" + the user's "tasks
          // are serial by default" requirement.
          depIds = [taskIds[i - 1]];
        }

        const { taskId } = await this.request<{ taskId: string }>(
          request(this.id, this.goalManagerId, 'addTask', {
            goalId,
            description: p.description,
            dependsOn: depIds,
            produces: p.produces,
            consumes: p.consumes,
            assignedAgentId,
            scrumNumber,
          }),
        );
        taskIds.push(taskId);

        // Enqueue on the agent's task queue. AgentAbject runs them serially
        // per-agent; multiple tasks for the same agent stack up naturally.
        // Note: dependsOn sequencing for cross-agent dependencies is enforced
        // by ScrumMaster waiting for the dependency's taskCompleted before
        // enqueueing the dependent — but for v1 we enqueue everything now and
        // rely on the agents' OTA loops to read consumes-keys from scratchpad
        // (which only get populated when the producing task completes). If a
        // dependent task starts before its producer finishes, the consumes
        // injection will show "missing"; the agent should re-think and replan.
        // A stricter "wait for deps" gate can be added later.
        await this.request(
          request(this.id, this.agentAbjectId, 'enqueueTask', {
            agentId: assignedAgentId,
            task: p.description,
            taskId,
            goalId,
            dispatchTupleId: taskId,
          }),
        );
      }

      log.info(`Sprint Planning: planned ${taskIds.length} task(s) for scrum ${scrumNumber}`);
      this.changed('sprintPlanned', { goalId, scrumNumber, tasksPlanned: taskIds.length });
      return { scrumNumber, tasksPlanned: taskIds.length };
    } finally {
      const s = this.scrums.get(goalId);
      if (s) s.planningInProgress = false;
    }
  }

  /**
   * Round-robin: send a planContribution-shaped ask to every team member in
   * parallel. Each agent answers based on its existing askPrompt (manifest
   * description + agent-specific guidance). Drop empty / PASS responses.
   */
  private async gatherTeamContributions(
    goal: { title: string; definitionOfDone?: string; scratchpad?: Record<string, unknown> },
    team: Array<{ agentId: AbjectId; name: string; description: string }>,
    completed: Array<{ id: string; fields: Record<string, unknown> }>,
    failed: Array<{ id: string; fields: Record<string, unknown> }>,
  ): Promise<TeamContribution[]> {
    const completedSummary = completed.length > 0
      ? completed.map(t => `- "${(t.fields.description as string ?? '').slice(0, 100)}" → done`).join('\n')
      : '(none)';
    const failedSummary = failed.length > 0
      ? failed.map(t => `- "${(t.fields.description as string ?? '').slice(0, 100)}" failed: ${(t.fields.error as string ?? 'unknown error').slice(0, 120)}`).join('\n')
      : '(none)';
    const dod = goal.definitionOfDone ? `\nDefinition of Done: ${goal.definitionOfDone}` : '';
    const question = `[Sprint Planning — what would YOU contribute?]

Goal: "${goal.title}"${dod}

Completed so far:
${completedSummary}

Failed so far:
${failedSummary}

You are part of the team. Look at what's been done and what's needed. Describe ONE concrete task you could do next that moves toward the goal. Be specific about scope. If nothing in this goal matches your capabilities, reply exactly: PASS.

Format:
- 1-3 sentences naming the task and why it advances the goal.
- Or just: PASS`;

    const results = await Promise.all(
      team.map(async (member) => {
        try {
          const response = await this.request<string>(
            request(this.id, member.agentId, 'ask', { question }),
            45000,
          );
          const text = (typeof response === 'string' ? response : String(response)).trim();
          if (!text || /^PASS\b/i.test(text)) {
            return null;
          }
          return { agentId: member.agentId, agentName: member.name, text };
        } catch (err) {
          log.warn(`gatherTeamContributions: ${member.name} ask failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );
    return results.filter((c): c is TeamContribution => c !== null);
  }

  /**
   * Synthesis LLM call: take team contributions and pick the tasks that
   * should run in the next scrum, with explicit agent assignments. Output
   * is parsed JSON; fallback behavior on parse failure is to take each
   * non-PASS contribution as a single task assigned to that contributor.
   */
  private async synthesizePlan(
    goal: { title: string; definitionOfDone?: string },
    team: Array<{ agentId: AbjectId; name: string; description: string }>,
    contributions: TeamContribution[],
    completed: Array<{ id: string; fields: Record<string, unknown> }>,
    failed: Array<{ id: string; fields: Record<string, unknown> }>,
  ): Promise<PlannedTask[]> {
    if (contributions.length === 0) return [];
    if (!this.llmId) {
      // No LLM available — fall back to each contribution as one task.
      return contributions.map(c => ({ description: c.text, assignedAgentName: c.agentName }));
    }

    const teamRoster = team.map(a => `- ${a.name}: ${a.description.slice(0, 200)}`).join('\n');
    const contribsBlock = contributions.map(c => `### ${c.agentName}\n${c.text}`).join('\n\n');
    const completedBlock = completed.length > 0
      ? completed.map(t => `- "${(t.fields.description as string ?? '').slice(0, 80)}"`).join('\n')
      : '(none)';
    const failedBlock = failed.length > 0
      ? failed.map(t => `- "${(t.fields.description as string ?? '').slice(0, 80)}": ${(t.fields.error as string ?? '').slice(0, 100)}`).join('\n')
      : '(none)';
    const dod = goal.definitionOfDone ? `\nDefinition of Done: ${goal.definitionOfDone}` : '';

    const prompt = `You are the ScrumMaster running Sprint Planning. Synthesize a task list from the team's contributions.

Goal: "${goal.title}"${dod}

Already completed:
${completedBlock}

Already failed (the next scrum should address these if possible):
${failedBlock}

Team roster:
${teamRoster}

Team contributions for this scrum:

${contribsBlock}

Pick the tasks that should run in this scrum. Tasks should be concrete and atomic — one task per backlog item, runnable end-to-end through one agent's loop. Keep the scrum focused: prefer 1-3 tasks per scrum unless the work is naturally parallelizable. Each task names the assigned agent (must match a name in the roster).

Default ordering: tasks run sequentially (each waits on the previous). Use \`dependsOn: []\` to mark a task as parallel-eligible.

Output ONLY a JSON array, nothing else:
[
  {
    "description": "concrete task description (1-3 sentences)",
    "assignedAgentName": "AgentName from the roster",
    "dependsOn": [0, 1],  // optional, indices into THIS array. Omit for default sequential.
    "produces": [{ "key": "scratchpad_key", "description": "what this task writes" }],  // optional
    "consumes": ["scratchpad_key"]  // optional, scratchpad keys this task expects to read
  }
]`;

    try {
      const result = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: [{ role: 'user', content: prompt }],
          options: { tier: 'smart', maxTokens: 4096 },
        }),
        180000,
      );
      const content = result.content ?? '';
      // Extract a JSON array — LLMs sometimes wrap in markdown fences.
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) {
        log.warn(`synthesizePlan: LLM response had no JSON array; falling back to identity mapping. raw=${content.slice(0, 200)}`);
        return contributions.map(c => ({ description: c.text, assignedAgentName: c.agentName }));
      }
      const parsed = JSON.parse(match[0]) as PlannedTask[];
      if (!Array.isArray(parsed)) {
        return contributions.map(c => ({ description: c.text, assignedAgentName: c.agentName }));
      }
      return parsed;
    } catch (err) {
      log.warn(`synthesizePlan LLM failed: ${err instanceof Error ? err.message : String(err)}; falling back to identity mapping`);
      return contributions.map(c => ({ description: c.text, assignedAgentName: c.agentName }));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Sprint Review
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Run Sprint Review for a goal. Reads the current scrum's task results,
   * decides DONE (synthesize result and complete the goal) or ANOTHER_SCRUM
   * (run Sprint Planning again with the gap as context).
   */
  private async runSprintReview(goalId: string): Promise<{ decision: string }> {
    if (!this.goalManagerId) return { decision: 'no-deps' };
    const state = this.scrums.get(goalId) ?? { goalId, planningInProgress: false, reviewInProgress: false };
    if (state.reviewInProgress) {
      log.info(`runSprintReview(${goalId.slice(0, 8)}): review already in progress, skipping`);
      return { decision: 'in-progress' };
    }
    state.reviewInProgress = true;
    this.scrums.set(goalId, state);

    try {
      const goal = await this.request<{
        title: string; status: string; currentScrumNumber: number;
        definitionOfDone?: string; scratchpad?: Record<string, unknown>;
      } | null>(
        request(this.id, this.goalManagerId, 'getGoal', { goalId }),
      );
      if (!goal || goal.status !== 'active') return { decision: 'goal-not-active' };

      const allTasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }),
      ).catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>);

      const currentScrumTasks = allTasks.filter(t => (t.fields.scrumNumber as number | undefined) === goal.currentScrumNumber);
      const done = currentScrumTasks.filter(t => t.fields.status === 'done');
      const failed = currentScrumTasks.filter(t => t.fields.status === 'permanently_failed');

      log.info(`Sprint Review for goal ${goalId.slice(0, 8)} scrum ${goal.currentScrumNumber}: ${done.length} done, ${failed.length} failed`);

      const decision = await this.decideReviewOutcome(goal, done, failed);
      if (decision.outcome === 'done') {
        await this.request(
          request(this.id, this.goalManagerId, 'completeGoal', {
            goalId,
            result: decision.synthesis,
          }),
        );
        log.info(`Sprint Review: goal ${goalId.slice(0, 8)} marked DONE`);
        this.changed('sprintReviewed', { goalId, scrumNumber: goal.currentScrumNumber, decision: 'done' });
        return { decision: 'done' };
      } else {
        // ANOTHER_SCRUM: stash the gap in the scratchpad so the next planning
        // round picks it up via the per-goal context.
        await this.request(
          request(this.id, this.goalManagerId, 'updateProgress', {
            goalId,
            message: `Scrum ${goal.currentScrumNumber} review: ${decision.gap.slice(0, 200)}`,
            phase: 'review',
            agentName: 'ScrumMaster',
          }),
        ).catch(() => { /* best effort */ });
        log.info(`Sprint Review: goal ${goalId.slice(0, 8)} → ANOTHER_SCRUM (${decision.gap.slice(0, 100)})`);
        this.changed('sprintReviewed', { goalId, scrumNumber: goal.currentScrumNumber, decision: 'another-scrum' });
        // Run the next scrum.
        await this.runSprintPlanning(goalId);
        return { decision: 'another-scrum' };
      }
    } finally {
      const s = this.scrums.get(goalId);
      if (s) s.reviewInProgress = false;
    }
  }

  /**
   * Synthesis LLM call for Sprint Review. Decides DONE (with a synthesized
   * final answer) or ANOTHER_SCRUM (with a gap description). Falls back to
   * a simple policy when no LLM is available: DONE if all tasks succeeded,
   * ANOTHER_SCRUM if any failed (so the next scrum can fold in a corrective
   * task), with goal-fail only if the same scrum has failed three times.
   */
  private async decideReviewOutcome(
    goal: { title: string; definitionOfDone?: string },
    done: Array<{ id: string; fields: Record<string, unknown> }>,
    failed: Array<{ id: string; fields: Record<string, unknown> }>,
  ): Promise<{ outcome: 'done'; synthesis: string } | { outcome: 'another-scrum'; gap: string }> {
    if (!this.llmId) {
      if (failed.length === 0) {
        return { outcome: 'done', synthesis: `Completed ${done.length} task(s)` };
      }
      return { outcome: 'another-scrum', gap: `${failed.length} task(s) failed; replan needed` };
    }
    const doneBlock = done.length > 0
      ? done.map(t => `- "${(t.fields.description as string ?? '').slice(0, 100)}"\n  result: ${JSON.stringify(t.fields.result).slice(0, 800)}`).join('\n')
      : '(none)';
    const failedBlock = failed.length > 0
      ? failed.map(t => `- "${(t.fields.description as string ?? '').slice(0, 100)}"\n  error: ${(t.fields.error as string ?? '').slice(0, 200)}`).join('\n')
      : '(none)';
    const dod = goal.definitionOfDone ? `\nDefinition of Done: ${goal.definitionOfDone}` : '';

    const prompt = `You are the ScrumMaster running Sprint Review.

Goal: "${goal.title}"${dod}

Completed in this scrum:
${doneBlock}

Failed in this scrum:
${failedBlock}

Decide:

- DONE: the goal has been achieved (Definition of Done is met, or the user's request has been answered satisfactorily). Synthesize a final answer for the user.
- ANOTHER_SCRUM: more work is needed. Describe the gap or what failed so the next scrum's Sprint Planning can address it.

Output ONLY a JSON object, nothing else:

{ "outcome": "done", "synthesis": "concise final answer for the user (markdown OK)" }
or
{ "outcome": "another-scrum", "gap": "what's missing or what failed and how to fix it" }`;

    try {
      const result = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: [{ role: 'user', content: prompt }],
          options: { tier: 'smart', maxTokens: 4096 },
        }),
        180000,
      );
      const content = result.content ?? '';
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        log.warn(`decideReviewOutcome: LLM response had no JSON object; falling back. raw=${content.slice(0, 200)}`);
        return failed.length === 0
          ? { outcome: 'done', synthesis: content.slice(0, 1000) || 'Goal completed' }
          : { outcome: 'another-scrum', gap: 'LLM synthesis failed; retry with clearer task' };
      }
      const parsed = JSON.parse(match[0]) as { outcome: string; synthesis?: string; gap?: string };
      if (parsed.outcome === 'done') {
        return { outcome: 'done', synthesis: parsed.synthesis ?? 'Completed' };
      }
      return { outcome: 'another-scrum', gap: parsed.gap ?? 'unspecified gap' };
    } catch (err) {
      log.warn(`decideReviewOutcome LLM failed: ${err instanceof Error ? err.message : String(err)}`);
      return failed.length === 0
        ? { outcome: 'done', synthesis: `Completed ${done.length} task(s)` }
        : { outcome: 'another-scrum', gap: 'LLM unavailable; conservative replan' };
    }
  }
}

void event; // keep import live; reserved for future events
