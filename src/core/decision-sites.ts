/**
 * Decision sites: every place the system asks a decision model to judge.
 *
 * A site is a named call point with a live mode that says what its answer
 * may do:
 *
 * - `advise`  the verdict becomes a hint the model sees; the model still decides.
 * - `act`     the verdict takes effect (a reversible shortcut above the site's threshold).
 *
 * `emulation: 'native-only'` marks per-step gates whose whole value is being
 * cheaper than the call they gate: emulating them on a chat model costs about
 * what they save, so they run only when a real decision model is configured.
 *
 * The Settings "Gates" toggle switches every built-in site on or off at once;
 * per-site overrides turn one site off or hold it at advise. Explicit calls
 * with no site (user objects, jobs) always run.
 */

export type DecisionMode = 'off' | 'advise' | 'act';
export type DecisionGates = 'on' | 'off';

export interface DecisionSite {
  description: string;
  /** What the site's answer does when it runs. */
  mode: 'advise' | 'act';
  emulation: 'allowed' | 'native-only';
}

export interface DecisionPolicy {
  gates: DecisionGates;
  /** Site id → mode, overriding the site's own (capped at it: an advise site cannot be made to act). */
  overrides?: Record<string, DecisionMode>;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = { gates: 'on', overrides: {} };

const site = (description: string, mode: DecisionSite['mode'], emulation: DecisionSite['emulation']): DecisionSite =>
  ({ description, mode, emulation });

export const DECISION_SITES: Record<string, DecisionSite> = {
  // ── The shared agent loop ──
  'agent.prediction': site('Did the action result bear out the agent\'s stated expectation?', 'advise', 'native-only'),
  'agent.progress': site('Is the agent progressing, circling, or repeating a failure?', 'advise', 'native-only'),
  'agent.stop': site('Should a stuck agent stop and fail with a diagnosis?', 'act', 'native-only'),
  'agent.failure': site('Why did an action fail (transient, bad arguments, wrong approach...)?', 'advise', 'allowed'),
  'agent.transient-retry': site('Retry an identical action once after a transient failure, without a think.', 'act', 'allowed'),
  'agent.tier': site('Can the next think step run on the balanced tier instead of smart?', 'act', 'native-only'),
  'agent.vision': site('Does the next step need to see the images in the conversation?', 'act', 'native-only'),
  'agent.completion': site('Does a done result actually complete the task?', 'act', 'allowed'),
  'agent.final': site('At the step limit: done or fail, without the forced smart call?', 'act', 'allowed'),
  'agent.knowledge': site('Which recalled knowledge entries are relevant to this task?', 'act', 'allowed'),
  'agent.delegation': site('Did the collaborator agree to the delegated task?', 'act', 'allowed'),
  'agent.ask-scope': site('Is a question to an agent within that agent\'s own described scope?', 'act', 'native-only'),

  // ── Chat, planning, and the goal lifecycle ──
  'chat.route': site('Does a user message need a goal, a direct answer, a clarification, or remembering?', 'act', 'native-only'),
  'chat.audit': site('Does a goal-less reply claim unobserved outcomes, absences, or unkept promises?', 'act', 'allowed'),
  'scrum.quick-dispatch': site('Is a new goal one step one roster agent clearly owns?', 'act', 'native-only'),
  'scrum.one-shot': site('Is a quick-dispatched result an answer, a grounded action, or an unsupported claim?', 'act', 'allowed'),
  'scrum.interjection': site('Does a note typed mid-goal change the in-flight plan?', 'act', 'allowed'),
  'scrum.review': site('Do a round\'s results satisfy the goal?', 'act', 'allowed'),
  'scrum.loop': site('Are rounds repeating the same failure?', 'advise', 'allowed'),
  'scrum.tier': site('How hard is the next planning decision?', 'act', 'native-only'),
  'goal.failure': site('Why did a task fail? The class is recorded beside the error for the planner.', 'advise', 'allowed'),
  'goal.produces': site('Does each declared output deliver what its description promises?', 'act', 'allowed'),
  'goal.health': site('Is a quiet goal progressing, waiting, looping, or stalled?', 'act', 'allowed'),
  'registry.find': site('Which registered object performs a requested capability?', 'act', 'allowed'),

  // ── Specialist agents ──
  'object-creator.tier': site('What will the object author\'s next step do (author, read, deploy, report...)?', 'act', 'native-only'),
  'object-creator.members': site('Which members of a large source the goal most likely touches.', 'advise', 'allowed'),
  'object-creator.advisor': site('Enough reading to edit? Re-reading? What the remaining budget should go to.', 'advise', 'allowed'),
  'object-creator.kind': site('Is an authoring task a create, modify, clone, investigation, or composition?', 'act', 'allowed'),
  'object-creator.review': site('Is a deployed change worth a semantic review?', 'act', 'allowed'),
  'object-creator.evidence': site('Did a call drive a behavior the user asked for?', 'advise', 'native-only'),
  'object-creator.draft': site('Which persisted draft does a task continue?', 'act', 'allowed'),
  'object-agent.tier': site('Does the object caller\'s next step need recovery or judgment?', 'act', 'native-only'),
  'web.screenshot': site('Does the next browsing step need the rendered screenshot?', 'act', 'native-only'),
  'web.page-state': site('What state is the page in (content, login, verification wall, loading...)?', 'act', 'native-only'),
  'web.profile': site('Which browser profile does a task intend?', 'act', 'allowed'),
  'web.tier': site('How hard is the next browsing decision?', 'act', 'native-only'),
  'skill.preselect': site('Which installed skill covers a task?', 'act', 'allowed'),
  'skill.result': site('What does the last skill command result mean (success, auth, usage error...)?', 'act', 'native-only'),
  'skill.catalog': site('Which catalog entry matches a request?', 'advise', 'allowed'),
  'external.tier': site('What does a command outcome mean for the next step?', 'act', 'native-only'),
  'external.auto-verify': site('Run the project\'s verification itself when completion was rejected as unverified.', 'act', 'allowed'),
  'external.syntax': site('Does a failing check mean the edited file no longer parses?', 'act', 'allowed'),
  'external.project': site('Which registered project does a task concern?', 'act', 'allowed'),
  'external.attribution': site('Were new failures introduced by this change, pre-existing, or concurrent?', 'advise', 'allowed'),
  'reviewer.worth': site('Is a finished goal worth a full learning review?', 'act', 'allowed'),
  'reviewer.predictions': site('Were each episode\'s predictions supported or contradicted?', 'act', 'allowed'),
  'reviewer.fidelity': site('Does the user-facing summary match the verification record?', 'act', 'allowed'),
  'reviewer.patterns': site('Did an applied pattern help, harm, or stay inconclusive?', 'act', 'allowed'),
  'reviewer.privacy': site('Does an authored skill carry workspace-specific detail?', 'advise', 'allowed'),
  'reviewer.dedupe': site('Is a new knowledge entry a duplicate or refinement of an existing one?', 'act', 'allowed'),
};

const MODE_RANK: Record<DecisionMode, number> = { off: 0, advise: 1, act: 2 };

/** The lower of two modes. */
export function capMode(mode: DecisionMode, cap: DecisionMode): DecisionMode {
  return MODE_RANK[mode] <= MODE_RANK[cap] ? mode : cap;
}

/**
 * The mode a site runs at under a policy. Unknown ids are explicit callers
 * (user objects, jobs, generated code): they asked for an answer, so they
 * get one whatever the gates say about the built-in sites.
 */
export function resolveSiteMode(siteId: string | undefined, policy: DecisionPolicy, nativeAvailable: boolean): DecisionMode {
  const spec = siteId ? DECISION_SITES[siteId] : undefined;
  if (!spec) return 'act';
  if (spec.emulation === 'native-only' && !nativeAvailable) return 'off';
  if (policy.gates === 'off') return 'off';
  const override = policy.overrides?.[siteId!];
  return override ? capMode(override, spec.mode) : spec.mode;
}
