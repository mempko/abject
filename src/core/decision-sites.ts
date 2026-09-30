/**
 * Decision sites: every place the system asks a decision model to judge.
 *
 * A site is a named call point with a policy. The policy decides what the
 * answer is allowed to do, so a new judgment can run for weeks logging what
 * it would have done before anything depends on it:
 *
 * - `shadow`  decide and log; change nothing.
 * - `advise`  the verdict becomes a hint the model sees; the model still decides.
 * - `act`     the verdict takes effect (a reversible shortcut above the site's threshold).
 *
 * `emulation: 'native-only'` marks per-step gates whose whole value is being
 * cheaper than the call they gate: emulating them on a chat model costs about
 * what they save, so they run only when a real decision model is configured.
 *
 * The global Settings toggle caps every site at once: off, shadow, on (each
 * site at its default), or full (each site at its highest mode). Per-site
 * overrides promote or demote one site after its ledger shows it is
 * calibrated. Explicit calls with no site (user objects, jobs) always run.
 * Shadow runs only with a real decision model: it is calibration, and an
 * emulated shadow judgment would spend a chat-model call to write a log line.
 */

export type DecisionMode = 'off' | 'shadow' | 'advise' | 'act';
export type DecisionGates = 'off' | 'shadow' | 'on' | 'full';

export interface DecisionSite {
  description: string;
  defaultMode: Exclude<DecisionMode, 'off'>;
  maxMode: Exclude<DecisionMode, 'off'>;
  emulation: 'allowed' | 'native-only';
}

export interface DecisionPolicy {
  gates: DecisionGates;
  /** Site id → mode, overriding the gates for that site (capped at its maxMode). */
  overrides?: Record<string, DecisionMode>;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = { gates: 'on', overrides: {} };

const site = (description: string, defaultMode: DecisionSite['defaultMode'], maxMode: DecisionSite['maxMode'], emulation: DecisionSite['emulation']): DecisionSite =>
  ({ description, defaultMode, maxMode, emulation });

export const DECISION_SITES: Record<string, DecisionSite> = {
  // ── The shared agent loop ──
  'agent.prediction': site('Did the action result bear out the agent\'s stated expectation?', 'advise', 'advise', 'native-only'),
  'agent.progress': site('Is the agent progressing, circling, or repeating a failure?', 'advise', 'advise', 'native-only'),
  'agent.stop': site('Should a stuck agent stop and fail with a diagnosis?', 'shadow', 'act', 'native-only'),
  'agent.failure': site('Why did an action fail (transient, bad arguments, wrong approach...)?', 'advise', 'advise', 'allowed'),
  'agent.transient-retry': site('Retry an identical action once after a transient failure, without a think.', 'shadow', 'act', 'allowed'),
  'agent.tier': site('Can the next think step run on the balanced tier instead of smart?', 'shadow', 'act', 'native-only'),
  'agent.vision': site('Does the next step need to see the images in the conversation?', 'shadow', 'act', 'native-only'),
  'agent.completion': site('Does a done result actually complete the task?', 'shadow', 'act', 'allowed'),
  'agent.final': site('At the step limit: done or fail, without the forced smart call?', 'shadow', 'act', 'allowed'),
  'agent.knowledge': site('Which recalled knowledge entries are relevant to this task?', 'shadow', 'act', 'allowed'),
  'agent.delegation': site('Did the collaborator agree to the delegated task?', 'shadow', 'act', 'allowed'),
  'agent.ask-scope': site('Is a question to an agent within that agent\'s own described scope?', 'shadow', 'act', 'native-only'),

  // ── Chat, planning, and the goal lifecycle ──
  'chat.route': site('Does a user message need a goal, a direct answer, a clarification, or remembering?', 'shadow', 'act', 'native-only'),
  'chat.audit': site('Does a goal-less reply claim unobserved outcomes, absences, or unkept promises?', 'advise', 'act', 'allowed'),
  'scrum.quick-dispatch': site('Is a new goal one step one roster agent clearly owns?', 'shadow', 'act', 'native-only'),
  'scrum.one-shot': site('Is a quick-dispatched result an answer, a grounded action, or an unsupported claim?', 'advise', 'act', 'allowed'),
  'scrum.interjection': site('Does a note typed mid-goal change the in-flight plan?', 'advise', 'act', 'allowed'),
  'scrum.review': site('Do a round\'s results satisfy the goal?', 'shadow', 'act', 'allowed'),
  'scrum.loop': site('Are rounds repeating the same failure?', 'advise', 'advise', 'allowed'),
  'scrum.tier': site('How hard is the next planning decision?', 'shadow', 'act', 'native-only'),
  'goal.failure': site('Why did a task fail? The class is recorded beside the error for the planner.', 'advise', 'advise', 'allowed'),
  'goal.produces': site('Does each declared output deliver what its description promises?', 'shadow', 'act', 'allowed'),
  'goal.health': site('Is a quiet goal progressing, waiting, looping, or stalled?', 'advise', 'act', 'allowed'),
  'registry.find': site('Which registered object performs a requested capability?', 'act', 'act', 'allowed'),

  // ── Specialist agents ──
  'object-creator.tier': site('What will the object author\'s next step do (author, read, deploy, report...)?', 'shadow', 'act', 'native-only'),
  'object-creator.members': site('Which members of a large source the goal most likely touches.', 'advise', 'advise', 'allowed'),
  'object-creator.advisor': site('Enough reading to edit? Re-reading? What the remaining budget should go to.', 'advise', 'advise', 'allowed'),
  'object-creator.kind': site('Is an authoring task a create, modify, clone, investigation, or composition?', 'advise', 'act', 'allowed'),
  'object-creator.review': site('Is a deployed change worth a semantic review?', 'shadow', 'act', 'allowed'),
  'object-creator.evidence': site('Did a call drive a behavior the user asked for?', 'advise', 'advise', 'native-only'),
  'object-creator.draft': site('Which persisted draft does a task continue?', 'shadow', 'act', 'allowed'),
  'object-agent.tier': site('Does the object caller\'s next step need recovery or judgment?', 'shadow', 'act', 'native-only'),
  'web.screenshot': site('Does the next browsing step need the rendered screenshot?', 'shadow', 'act', 'native-only'),
  'web.page-state': site('What state is the page in (content, login, verification wall, loading...)?', 'advise', 'act', 'native-only'),
  'web.profile': site('Which browser profile does a task intend?', 'advise', 'act', 'allowed'),
  'web.tier': site('How hard is the next browsing decision?', 'shadow', 'act', 'native-only'),
  'skill.preselect': site('Which installed skill covers a task?', 'advise', 'act', 'allowed'),
  'skill.result': site('What does the last skill command result mean (success, auth, usage error...)?', 'shadow', 'act', 'native-only'),
  'skill.catalog': site('Which catalog entry matches a request?', 'advise', 'advise', 'allowed'),
  'external.tier': site('What does a command outcome mean for the next step?', 'shadow', 'act', 'native-only'),
  'external.auto-verify': site('Run the project\'s verification itself when completion was rejected as unverified.', 'shadow', 'act', 'allowed'),
  'external.syntax': site('Does a failing check mean the edited file no longer parses?', 'shadow', 'act', 'allowed'),
  'external.project': site('Which registered project does a task concern?', 'advise', 'act', 'allowed'),
  'external.attribution': site('Were new failures introduced by this change, pre-existing, or concurrent?', 'advise', 'advise', 'allowed'),
  'reviewer.worth': site('Is a finished goal worth a full learning review?', 'shadow', 'act', 'allowed'),
  'reviewer.predictions': site('Were each episode\'s predictions supported or contradicted?', 'advise', 'act', 'allowed'),
  'reviewer.fidelity': site('Does the user-facing summary match the verification record?', 'advise', 'act', 'allowed'),
  'reviewer.patterns': site('Did an applied pattern help, harm, or stay inconclusive?', 'shadow', 'act', 'allowed'),
  'reviewer.privacy': site('Does an authored skill carry workspace-specific detail?', 'advise', 'advise', 'allowed'),
  'reviewer.dedupe': site('Is a new knowledge entry a duplicate or refinement of an existing one?', 'advise', 'act', 'allowed'),
};

const MODE_RANK: Record<DecisionMode, number> = { off: 0, shadow: 1, advise: 2, act: 3 };

/** The lower of two modes. */
export function capMode(mode: DecisionMode, cap: DecisionMode): DecisionMode {
  return MODE_RANK[mode] <= MODE_RANK[cap] ? mode : cap;
}

/** Whether `mode` permits at least `needed` (e.g. act permits advise). */
export function modeAllows(mode: DecisionMode | undefined, needed: DecisionMode): boolean {
  return !!mode && MODE_RANK[mode] >= MODE_RANK[needed];
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
  const override = policy.overrides?.[siteId!];
  const mode: DecisionMode = override ? capMode(override, spec.maxMode)
    : policy.gates === 'off' ? 'off'
      : policy.gates === 'shadow' ? 'shadow'
        : policy.gates === 'full' ? spec.maxMode
          : spec.defaultMode;
  // Shadow exists to calibrate a decision model before a site acts on it.
  // Without one, a shadow run would spend a chat-model call per judgment
  // only to log it, so it does not run.
  return mode === 'shadow' && !nativeAvailable ? 'off' : mode;
}
