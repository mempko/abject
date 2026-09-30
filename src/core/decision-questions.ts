/**
 * Shared decision questions: the judgments several objects ask about.
 *
 * Each builder returns the typed questions for one judgment (see
 * src/llm/decision.ts); callers supply their own `state` and send both
 * through `askDecision`. Keeping one taxonomy per judgment means a failure
 * classified in the agent loop and one classified by the goal lifecycle use
 * the same words, and their ledgers can be read side by side.
 *
 * Instructions stay generic: no object, agent, or skill names. Where options
 * must name agents, the caller builds them from the live roster.
 */

import type { DecisionQuestion } from '../llm/decision.js';

type Questions = Record<string, DecisionQuestion>;

// ── Did the result bear out the stated expectation? ──────────────────────

export const PREDICTION_VERDICTS = ['supported', 'partially_supported', 'contradicted', 'unresolved'] as const;

export function predictionQuestions(): Questions {
  return {
    prediction: {
      type: 'choice',
      instructions: 'Before acting, the agent stated `expect`: what it predicted the action would show. Judge whether `result` bears that prediction out. Judge the observable claim, not whether the operation succeeded: an expected rejection can support the prediction, and a successful call can contradict it.',
      criteria: {
        supported: 'The result shows what the prediction said it would.',
        partially_supported: 'Some predicted claims hold; others are absent or different.',
        contradicted: 'The result shows something incompatible with the prediction.',
        unresolved: 'The result does not contain enough evidence to tell.',
      },
    },
  };
}

// ── Is the loop making progress? ─────────────────────────────────────────

export const LOOP_STATES = ['none', 'same_failure_repeating', 'same_success_no_new_info', 'alternating_approaches', 'blocked_external'] as const;

export function progressQuestions(): Questions {
  return {
    progress: {
      type: 'score',
      instructions: 'Rate the agent\'s recent steps (`recent`, oldest first) against `task`.',
      criteria: [
        'Regressing: undoing or breaking earlier work',
        'Stalled: no new information or effect',
        'Circling: varied actions around the same unresolved point',
        'Slow progress: some new evidence or effect',
        'Clear progress: moving steadily toward the task outcome',
      ],
    },
    loop_state: {
      type: 'choice',
      instructions: 'Is the agent stuck in a loop in `recent`?',
      criteria: {
        none: 'No loop: steps differ and results add something new.',
        same_failure_repeating: 'The same failure keeps coming back, even with different arguments.',
        same_success_no_new_info: 'Steps succeed but keep returning what the agent already had.',
        alternating_approaches: 'The agent switches back and forth between approaches without resolving anything.',
        blocked_external: 'Progress needs a permission, resource, or person the agent cannot reach.',
      },
    },
  };
}

export function stopQuestions(): Questions {
  return {
    should_end_now: {
      type: 'noul',
      instructions: 'Given `recent` and the repeated failure in `streak`, is continuing very unlikely to change the outcome, so the agent should stop and fail with a diagnosis?',
    },
  };
}

// ── Why did it fail? ─────────────────────────────────────────────────────

export const FAILURE_KINDS = [
  'transient', 'bad_arguments', 'wrong_approach', 'missing_capability', 'permission_denied',
  'external_blocked', 'target_bug', 'specification', 'budget', 'verification', 'impossible', 'cancelled',
] as const;
export type FailureKind = typeof FAILURE_KINDS[number];

const FAILURE_CRITERIA: Record<FailureKind, string> = {
  transient: 'Timeout, rate limit, outage, crash, or network flake: an unchanged retry would likely succeed.',
  bad_arguments: 'The approach is right; the arguments, payload, or command flags need fixing.',
  wrong_approach: 'This route will not work; a different approach is needed.',
  missing_capability: 'The actor lacks a needed tool, method, or access; another object or agent might have it.',
  permission_denied: 'A permission boundary refused it: a decision, not a malfunction.',
  external_blocked: 'It needs the user, a login, or outside state the actor cannot reach.',
  target_bug: 'The called object or service is broken.',
  specification: 'The request is ambiguous, contradictory, or missing inputs.',
  budget: 'A token, cost, or step budget ran out before the work finished.',
  verification: 'The work was done but acceptance rejected it (missing outputs, schema, review).',
  impossible: 'Nothing available can meet the requirement.',
  cancelled: 'Stopped by the user, superseded, or cancelled by a re-plan.',
};

/** Classify a failure. `kinds` narrows the taxonomy for a context (an action vs a whole task). */
export function failureQuestions(kinds: readonly FailureKind[] = FAILURE_KINDS): Questions {
  return {
    failure_kind: {
      type: 'choice',
      instructions: 'Classify the most likely cause of the failure in `error`, using `action` and any `history` of earlier failures.',
      criteria: Object.fromEntries(kinds.map(k => [k, FAILURE_CRITERIA[k]])),
    },
    retry_same: {
      type: 'noul',
      instructions: 'Would repeating exactly the same thing, unchanged, plausibly succeed?',
    },
  };
}

/** One line of guidance per failure kind, phrased as what to do next. */
export const FAILURE_GUIDANCE: Record<FailureKind, string> = {
  transient: 'an identical retry may succeed',
  bad_arguments: 'keep the approach and fix the arguments',
  wrong_approach: 'this route will not work; choose another',
  missing_capability: 'ask the owner or the Registry who has this capability',
  permission_denied: 'treat it as a boundary: work within it or ask the user',
  external_blocked: 'ask the user for what is needed, or report the block',
  target_bug: 'the callee looks broken; report it with the evidence',
  specification: 'clarify the request before retrying',
  budget: 'finish what is essential and report the rest',
  verification: 'address what acceptance rejected, then complete again',
  impossible: 'report why it cannot be done',
  cancelled: 'stop; the work was cancelled',
};

// ── Does a done result complete the task? ────────────────────────────────

export function completionQuestions(): Questions {
  return {
    completion_status: {
      type: 'choice',
      instructions: 'The agent reported `result` as finishing `task`. Judge it against the task, using `recent` (its last steps and what they returned) and `evidence` (openings of the larger results it read).',
      criteria: {
        complete_verified: 'Delivers what the task asked, and `recent` or `evidence` shows the work was done or checked.',
        complete_unverified: 'Plausibly delivers it, but neither `recent` nor `evidence` shows the work was done or checked.',
        partial: 'Delivers part of what the task asked.',
        not_done: 'Describes intentions or plans rather than outcomes.',
        wrong_task: 'Answers a different request than `task`.',
      },
    },
    claims_unsupported: {
      type: 'noul',
      instructions: 'Does `result` assert facts, effects, or verification that neither `recent` nor `evidence` supports? Summarizing or restating what those show counts as supported.',
    },
  };
}

export function finalDispositionQuestions(): Questions {
  return {
    final_disposition: {
      type: 'choice',
      instructions: 'The agent used its whole step budget on `task`. From `recent`, `evidence` and `last_result`, how does it stand?',
      criteria: {
        done_complete: 'The requested work is finished and its checks hold.',
        fail_with_partial: 'Useful work or findings exist, but the task is incomplete.',
        fail_nothing: 'Nothing usable was produced.',
      },
    },
    last_result_is_deliverable: {
      type: 'noul',
      instructions: 'Is `last_result` itself the deliverable `task` asked for, as it stands?',
    },
  };
}

// ── What does a report claim? (replaces the claim-shape regexes) ─────────

export const REPORT_KINDS = ['answer', 'grounded_action', 'ungrounded_claim', 'bare_ack', 'partial_or_failure', 'promise_without_action', 'question_to_user', 'conversation'] as const;

export function reportQuestions(): Questions {
  return {
    asserts_action: {
      type: 'noul',
      instructions: 'Does `text` state or imply that an action was performed, that live system or window state now holds, or that something was verified?',
    },
    asserts_absence: {
      type: 'noul',
      instructions: 'Does `text` tell the reader that an object, agent, tool, skill, service, capability, or integration does not exist, is not installed, or cannot be reached? Findings about content (such as "no blocking issues found") do not count.',
    },
    cites_evidence: {
      type: 'noul',
      instructions: 'Does `text` cite runtime-produced evidence: returned data, a command with its exit code, object ids, test or file counts, a verifier verdict, observed state?',
    },
    report_kind: {
      type: 'choice',
      instructions: 'What kind of reply is `text` to `request`?',
      criteria: {
        answer: 'Delivers the data, content, or outcome the request asked for.',
        grounded_action: 'Reports an action together with concrete evidence it happened.',
        ungrounded_claim: 'Asserts an action or state with nothing showing it happened.',
        bare_ack: 'Only says the work finished; the content itself is missing.',
        partial_or_failure: 'Covers part of the request, or reports a blocker or absence as the result.',
        promise_without_action: 'Says it will do something, with nothing set in motion.',
        question_to_user: 'Asks the user something.',
        conversation: 'A greeting, thanks, or small talk.',
      },
    },
  };
}

// ── Is a question within this agent's own described scope? ───────────────

export function askScopeQuestions(): Questions {
  return {
    in_scope: {
      type: 'noul',
      instructions: 'Could the agent described in `agent` contribute to what `question` asks, by its own description (including what it says it does not do)?',
    },
  };
}

// ── Knowledge relevance (one score per entry) ────────────────────────────

export function relevanceQuestions(count: number): Questions {
  const out: Questions = {};
  for (let i = 0; i < count; i++) {
    out[`rel_${i}`] = {
      type: 'score',
      instructions: `How much would \`entries[${i}]\` change how \`task\` is done?`,
      criteria: [
        'Irrelevant: a different subject',
        'Background: same area, would not change any action',
        'Useful: would change how the task is done',
        'Critical: the task likely fails or repeats a known mistake without it',
      ],
    };
  }
  return out;
}

// ── Delegation agreement ────────────────────────────────────────────────

export function delegationQuestions(): Questions {
  return {
    agreement: {
      type: 'choice',
      instructions: 'A collaborator was asked whether it can execute `child_task`. Read its reply in `agreement` and classify it.',
      criteria: {
        accept: 'It can do the task as stated.',
        accept_with_constraints: 'It can, within stated limits.',
        decline_out_of_scope: 'The task is not this collaborator\'s role.',
        needs_clarification: 'The task is underspecified for it.',
      },
    },
  };
}

// ── Mid-goal user notes ─────────────────────────────────────────────────

export const NOTE_INTENTS = ['acknowledge', 'answer', 'constraint', 'redirect', 'stop', 'status'] as const;

export function interjectionQuestions(hasPendingQuestion: boolean): Questions {
  const out: Questions = {
    intent: {
      type: 'choice',
      instructions: 'The user typed `note` while a multi-agent goal was running. Judged against `goal`, `pending_question` and `in_flight`, what does the note ask the system to do?',
      criteria: {
        acknowledge: 'Thanks, ok, or encouragement: no new information or request.',
        answer: 'Answers the question the goal is waiting on.',
        constraint: 'Adds a detail or preference that fits the current plan and can wait for the next planning boundary.',
        redirect: 'Changes scope, target, or approach, so in-flight work may be wasted.',
        stop: 'Asks to stop, cancel, or abandon the goal.',
        status: 'Asks how it is going without changing the work.',
      },
    },
    conflicts: {
      type: 'noul',
      instructions: 'Does `note` contradict or invalidate any task in `in_flight`?',
    },
  };
  if (!hasPendingQuestion) delete (out.intent as { criteria: Record<string, string> }).criteria.answer;
  return out;
}

// ── Round and goal outcomes ─────────────────────────────────────────────

export function roundOutcomeQuestions(): Questions {
  return {
    round_outcome: {
      type: 'choice',
      instructions: 'All tasks of a planning round finished. Judge `completed` (with `verification`) against `goal`.',
      criteria: {
        satisfied: 'The outcome the goal asked for holds, with evidence in the results.',
        follow_up: 'A result is a workaround, unverified, would not survive a restart, or recommends a durable follow-up.',
        cross_check: 'Figures, irreversible actions, or published artifacts the user will rely on lack independent confirmation.',
        next_phase: 'This round prepared or researched; the actual work remains.',
        corrective: 'The results show the outcome was not achieved.',
      },
    },
    results_grounded: {
      type: 'noul',
      instructions: 'Do the results cite concrete evidence (returned data, commands with exit codes, object ids, receipts, observed state) rather than only asserting success?',
    },
  };
}

export function goalHealthQuestions(): Questions {
  return {
    health: {
      type: 'choice',
      instructions: 'A goal has gone quiet. From `progress` (newest last) and `tasks`, what state is it in?',
      criteria: {
        progressing: 'Recent entries show distinct new steps or results.',
        waiting_external: 'Legitimately waiting on the user, a job, or an outside service.',
        looping: 'Repeating actions or messages with no new results.',
        stalled: 'Nothing is running and nothing is happening.',
        unrecoverable: 'Errors show the goal cannot proceed.',
      },
    },
  };
}

/** Does each declared output deliver its description? One noul per key. */
export function producesQuestions(keys: string[]): Questions {
  const out: Questions = {};
  keys.forEach((key, i) => {
    out[`satisfied_${i}`] = {
      type: 'noul',
      instructions: `Does \`outputs[${i}].value\` deliver what \`outputs[${i}].description\` promises? It does not if it is empty, a placeholder, an error message, a TODO, or says the work will happen later. A reference to where the content is stored counts when the description allows it.`,
    };
  });
  return out;
}
