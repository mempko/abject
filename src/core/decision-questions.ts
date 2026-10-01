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

// ── Writing questions ───────────────────────────────────────────────────
//
// Two rules keep a decision from misfiring:
// 1. Each criterion says what it covers, what it does not (the reading a
//    model is most likely to confuse it with), and an example or two. A
//    one-line description invites the model to stretch it.
// 2. One choice decides each action. When an action depends on two facts
//    (is it a goal AND is it self-contained), make them one option
//    ("goal_self_contained") rather than two answers combined in code: one
//    answer cannot contradict itself. Other questions may add hints or logs.

/** A criterion in the shared shape: what it covers, what it does not, examples. */
export function criterion(what: string, extra: { notFor?: string; examples?: string[] } = {}): Record<string, unknown> {
  return {
    what,
    ...(extra.notFor ? { not_for: extra.notFor } : {}),
    ...(extra.examples?.length ? { examples: extra.examples } : {}),
  };
}

/** Instructions in the shared shape: the question, what to focus on, and what is out of scope. */
export function instruction(question: string, extra: { focus?: string; notFor?: string; examples?: string[] } = {}): Record<string, unknown> {
  return {
    question,
    ...(extra.focus ? { focus: extra.focus } : {}),
    ...(extra.notFor ? { not_for: extra.notFor } : {}),
    ...(extra.examples?.length ? { examples: extra.examples } : {}),
  };
}

// ── Did the result bear out the stated expectation? ──────────────────────

export const PREDICTION_VERDICTS = ['supported', 'partially_supported', 'contradicted', 'unresolved'] as const;

export function predictionQuestions(): Questions {
  return {
    prediction: {
      type: 'choice',
      instructions: instruction('Before acting, the agent stated `expect`: what it predicted the action would show. Does `result` bear that prediction out?', {
        focus: 'The content the prediction named, read from `result` itself.',
        notFor: 'Whether the operation reported success: a successful job whose calls all failed contradicts a prediction about their content, and an expected rejection can support one.',
      }),
      criteria: {
        supported: criterion('The result shows what the prediction said it would.', {
          notFor: 'A call that merely succeeded when the prediction was about what it would return.',
          examples: ['Predicted three saved items; the list has three.'],
        }),
        partially_supported: criterion('Some predicted claims hold; others are missing or different.', {
          examples: ['Predicted ten emails with subjects; eight came back.'],
        }),
        contradicted: criterion('The result shows something incompatible with the prediction.', {
          examples: ['Predicted email contents; every call inside the job returned an error.', 'Predicted the window shows a chart; it shows "No data".'],
        }),
        unresolved: criterion('The result holds too little to tell either way.', {
          examples: ['Only a handle to a held payload', 'A truncated preview that stops before the predicted content'],
        }),
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
      instructions: instruction('Rate the agent\'s recent steps (`recent`, oldest first) against `task`.', {
        notFor: 'How many steps were taken: several reads that each add new facts are progress.',
      }),
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
      instructions: instruction('Is the agent stuck in a loop in `recent`?'),
      criteria: {
        none: criterion('No loop: steps differ and their results add something new.', {
          notFor: 'Repeating a kind of action (reading several different files) when each brings new information.',
        }),
        same_failure_repeating: criterion('The same failure keeps coming back, even with changed arguments.', {
          examples: ['Three deploys in a row fail with the same TypeError.'],
        }),
        same_success_no_new_info: criterion('Steps succeed but keep returning what the agent already had.', {
          examples: ['The same outline read three times.'],
        }),
        alternating_approaches: criterion('The agent switches back and forth between approaches without resolving anything.', {
          examples: ['Edit A, revert, edit B, revert to A.'],
        }),
        blocked_external: criterion('Progress needs a permission, resource, or person the agent cannot reach.', {
          examples: ['Every attempt is refused by a permission prompt.', 'The site requires a login the agent does not have.'],
        }),
      },
    },
  };
}

export function stopQuestions(): Questions {
  return {
    should_end_now: {
      type: 'noul',
      instructions: instruction('Given `recent` and the repeated failure in `streak`, is continuing very unlikely to change the outcome, so the agent should stop and fail with a diagnosis?', {
        notFor: 'A failure the agent is still varying its approach to; that is still worth continuing.',
      }),
    },
  };
}

// ── Why did it fail? ─────────────────────────────────────────────────────

export const FAILURE_KINDS = [
  'transient', 'bad_arguments', 'wrong_approach', 'missing_capability', 'permission_denied',
  'external_blocked', 'target_bug', 'specification', 'budget', 'verification', 'impossible', 'cancelled',
] as const;
export type FailureKind = typeof FAILURE_KINDS[number];

const FAILURE_CRITERIA: Record<FailureKind, Record<string, unknown>> = {
  transient: criterion('A passing problem: an unchanged retry would likely succeed.', {
    notFor: 'An error that names a wrong argument, a missing method, or a refusal; retrying those unchanged fails again.',
    examples: ['HTTP 429 rate limit', 'Request timed out', 'Provider overloaded (529)'],
  }),
  bad_arguments: criterion('The approach is right; the arguments, payload, or command flags need fixing.', {
    examples: ['grep: invalid option', 'oldText not found in the file'],
  }),
  wrong_approach: criterion('This route will not work; a different approach is needed.', {
    examples: ['The object has no way to do this; another route is needed.'],
  }),
  missing_capability: criterion('The actor lacks a needed tool, method, or access; another object or agent might have it.', {
    examples: ['METHOD_NOT_FOUND', 'could not find an object named X'],
  }),
  permission_denied: criterion('A permission boundary refused it: a decision, not a malfunction.', {
    examples: ['Permission denied by the user', 'Not permitted in this sandbox'],
  }),
  external_blocked: criterion('It needs the user, a login, or outside state the actor cannot reach.', {
    examples: ['The page requires signing in', 'Waiting on a two-factor code'],
  }),
  target_bug: criterion('The called object or service is broken.', {
    examples: ['TypeError thrown inside the callee', 'HTTP 500 from the service'],
  }),
  specification: criterion('The request is ambiguous, contradictory, or missing inputs.'),
  budget: criterion('A token, cost, or step budget ran out before the work finished.'),
  verification: criterion('The work was done but acceptance rejected it (missing outputs, schema, review).'),
  impossible: criterion('Nothing available can meet the requirement.'),
  cancelled: criterion('Stopped by the user, superseded, or cancelled by a re-plan.'),
};

/** Classify a failure. `kinds` narrows the taxonomy for a context (an action vs a whole task). */
export function failureQuestions(kinds: readonly FailureKind[] = FAILURE_KINDS): Questions {
  return {
    failure_kind: {
      type: 'choice',
      instructions: instruction('Classify the most likely cause of the failure in `error`, using `action` and any `history` of earlier failures.'),
      criteria: Object.fromEntries(kinds.map(k => [k, FAILURE_CRITERIA[k]])),
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
      instructions: instruction('The agent reported `result` as finishing `task`. Judge it against the task, using `recent` (its last steps and what they returned) and `evidence` (openings of the larger results it read).', {
        focus: 'Whether the result delivers the outcome the task asked for.',
      }),
      criteria: {
        complete_verified: criterion('Delivers what the task asked, and `recent` or `evidence` shows the work was done or checked.', {
          notFor: 'A result that only restates the plan.',
          examples: ['Lists the twelve emails it read, which appear in `evidence`.'],
        }),
        complete_unverified: criterion('Plausibly delivers it, but neither `recent` nor `evidence` shows the work was done or checked.'),
        partial: criterion('Delivers part of what the task asked.', {
          examples: ['Reviewed eight of the twelve emails.'],
        }),
        not_done: criterion('Describes intentions or plans rather than outcomes.', {
          notFor: 'A finished result that also suggests next steps.',
          examples: ['I will add the toggle next.', 'Next I would update the settings.'],
        }),
        wrong_task: criterion('Answers a different request than `task`.', {
          examples: ['Asked to rename a file; reports the file\'s contents.'],
        }),
      },
    },
  };
}

/** The outcome at the step limit, one choice: settle as done, write up, or fail. */
export function finalDispositionQuestions(): Questions {
  return {
    final_disposition: {
      type: 'choice',
      instructions: instruction('The agent used its whole step budget on `task`. From `recent`, `evidence` and `last_result`, how does it stand?'),
      criteria: {
        done_last_result_is_deliverable: criterion('The work is finished and `last_result` itself is the deliverable the task asked for, as it stands.', {
          notFor: 'Finished work whose deliverable still needs writing up from several steps.',
          examples: ['The task asked for a list; `last_result` is that list.'],
        }),
        done_needs_writeup: criterion('The work is finished and its checks hold, but the deliverable has to be written up from what was gathered.'),
        fail_with_partial: criterion('Useful work or findings exist, but the task is incomplete.'),
        fail_nothing: criterion('Nothing usable was produced.'),
      },
    },
  };
}

// ── What kind of reply or report is it? (replaces the claim-shape regexes) ──

/** How Chat reads its own goal-less reply: one choice decides whether to audit it. */
export const REPLY_KINDS_TO_AUDIT = ['unsupported_action_claim', 'absence_claim', 'promise_without_action'] as const;

export function replyKindQuestions(): Questions {
  return {
    reply_kind: {
      type: 'choice',
      instructions: instruction('What kind of reply is `text` to `request`? No goal ran this turn, so the writer did not act on or look at anything live.', {
        focus: 'Whether the writer claims it just did, observed, or checked something itself.',
      }),
      criteria: {
        answer: criterion('Answers the question from knowledge, the conversation, or earlier goal results.', {
          notFor: 'Claims that the writer itself just acted or looked at something.',
          examples: ['The paper shows filler tokens add parallel computation.', 'Yes, your understanding matches the earlier summary.'],
        }),
        question_to_user: criterion('Asks the user something.'),
        conversation: criterion('A greeting, thanks, or small talk.'),
        unsupported_action_claim: criterion('Claims the writer itself just performed an action, observed live state, or verified something, with no goal run to do it.', {
          notFor: 'Facts about papers, articles, or earlier goal results, even when they mention testing or verification.',
          examples: ['I updated the settings.', 'The window now shows the chart.', 'I checked and the server is up.'],
        }),
        absence_claim: criterion('Tells the user something is missing, not installed, unavailable, or out of reach.', {
          notFor: 'Findings about content, such as "no blocking issues found".',
          examples: ['There is no calendar integration installed.'],
        }),
        promise_without_action: criterion('Says it will do something, with nothing set in motion.', {
          examples: ['Sure, I will check that for you.'],
        }),
      },
    },
  };
}

/** How ScrumMaster reads a task's result for its goal: one choice decides complete, synthesize, or review. */
export function resultKindQuestions(): Questions {
  return {
    result_kind: {
      type: 'choice',
      instructions: instruction('A task finished a goal in one step. What kind of result is `text` for `request`?', {
        focus: 'Whether the person who asked would be satisfied reading only `text`.',
      }),
      criteria: {
        answer: criterion('Speaks directly to the person who asked and delivers the data, content, or outcome they wanted.', {
          notFor: 'A bare "done", a summary that leaves out what was asked for, or a report addressed to whoever coordinates the work.',
          examples: ['Latest email from the bank: "Your statement is ready", sent 08:14.'],
        }),
        report_not_reply: criterion('Holds what the request asked for, but reads as a worker\'s report rather than a reply to the person: how it was done (endpoints, parameters, tools), notes for a coordinator, or labels such as "Answer for the user".', {
          notFor: 'A reply that names its source in passing, such as "according to NOAA".',
          examples: ['Fetched via the CO-OPS API (product=predictions, datum=MLLW). Answer for the user: low tide is at 3:41 AM.'],
        }),
        grounded_action: criterion('Reports an action together with concrete evidence it happened.', {
          examples: ['Committed a513b8d on main; tests passed (exit 0).'],
        }),
        unsupported_claim: criterion('Asserts an action or state with nothing showing it happened.', {
          examples: ['It is now working.', 'Fixed the issue.'],
        }),
        bare_ack: criterion('Only says the work finished; the content itself is missing.', {
          examples: ['Done.', 'Task complete.'],
        }),
        partial_or_failure: criterion('Covers part of the request, or reports a blocker or absence as the result.', {
          examples: ['Could not find any matching emails.', 'Reviewed three of the five files.'],
        }),
      },
    },
  };
}

// ── Is a question within this agent's own described scope? ───────────────

export function askScopeQuestions(): Questions {
  return {
    in_scope: {
      type: 'noul',
      instructions: instruction('Could the agent described in `agent` contribute to what `question` asks, by its own description?', {
        focus: 'What the description says the agent does, and what it says it does not do.',
        notFor: 'Whether the question merely mentions the agent; a question about a neighbouring kind of work is out of scope.',
      }),
    },
  };
}

// ── Knowledge relevance (one score per entry) ────────────────────────────

export function relevanceQuestions(count: number): Questions {
  const out: Questions = {};
  for (let i = 0; i < count; i++) {
    out[`rel_${i}`] = {
      type: 'score',
      instructions: instruction(`How much would \`entries[${i}]\` change how \`task\` is done?`, {
        notFor: 'Sharing words with the task: an entry about a different system that happens to use the same words is irrelevant.',
      }),
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
      instructions: instruction('A collaborator was asked whether it can execute `child_task`. Read its reply in `agreement` and classify it.'),
      criteria: {
        accept: criterion('It can do the task as stated.'),
        accept_with_constraints: criterion('It can, within limits it states.', {
          examples: ['Yes, but only for files inside the registered project.'],
        }),
        decline_out_of_scope: criterion('The task is not this collaborator\'s role.', {
          notFor: 'Accepting with conditions.',
          examples: ['I only answer questions about myself.'],
        }),
        needs_clarification: criterion('The task is underspecified for it.', {
          examples: ['Which project do you mean?'],
        }),
      },
    },
  };
}

// ── Mid-goal user notes (one choice: does it change in-flight work?) ─────

export const DEFERRABLE_NOTES = ['acknowledge', 'status_question', 'fitting_constraint'] as const;

export function interjectionQuestions(hasPendingQuestion: boolean): Questions {
  const criteria: Record<string, Record<string, unknown>> = {
    acknowledge: criterion('Thanks, ok, or encouragement: no new information or request.', {
      examples: ['thanks, looks good so far'],
    }),
    status_question: criterion('Asks how it is going without changing the work.', {
      examples: ['how is it going?'],
    }),
    fitting_constraint: criterion('Adds a detail or preference that fits the current plan, so nothing in flight is wasted; it can wait for the next planning step.', {
      notFor: 'A detail that changes what a task in `in_flight` is doing.',
      examples: ['use blue for the buttons too'],
    }),
    redirect: criterion('Changes scope, target, or approach, or contradicts a task in `in_flight`, so in-flight work may be wasted.', {
      examples: ['actually make it a countdown instead'],
    }),
    stop: criterion('Asks to stop, cancel, or abandon the goal.', {
      examples: ['never mind, cancel this'],
    }),
  };
  if (hasPendingQuestion) {
    criteria.answer = criterion('Answers the question the goal is waiting on (`pending_question`).', {
      examples: ['2', 'yes, the second one'],
    });
  }
  return {
    intent: {
      type: 'choice',
      instructions: instruction('The user typed `note` while a multi-agent goal was running. Judged against `goal`, `pending_question` and `in_flight`, what does the note ask the system to do?'),
      criteria,
    },
  };
}

// ── Round and goal outcomes ─────────────────────────────────────────────

export function roundOutcomeQuestions(): Questions {
  return {
    round_outcome: {
      type: 'choice',
      instructions: instruction('All tasks of a planning round finished. Judge `completed` (with `verification`) against `goal`.', {
        focus: 'Whether the outcome the user asked for now holds, and whether the results show it.',
      }),
      criteria: {
        satisfied_with_evidence: criterion('The outcome the goal asked for holds, and the results cite concrete evidence: returned data, commands with exit codes, object ids, receipts, observed state.', {
          notFor: 'Results that only assert success.',
          examples: ['The report lists the six figures it fetched and the command that produced them.'],
        }),
        satisfied_unverified: criterion('The outcome looks achieved, but the results only assert it.', {
          examples: ['Fixed and working.'],
        }),
        follow_up: criterion('A result is a workaround, unverified, would not survive a restart, or recommends a durable follow-up.'),
        cross_check: criterion('Figures, irreversible actions, or published artifacts the user will rely on lack independent confirmation.'),
        next_phase: criterion('This round prepared or researched; the actual work remains.', {
          examples: ['Gathered the requirements; nothing is built yet.'],
        }),
        corrective: criterion('The results show the outcome was not achieved.'),
      },
    },
  };
}

export function goalHealthQuestions(): Questions {
  return {
    health: {
      type: 'choice',
      instructions: instruction('A goal has gone quiet. From `progress` (newest last) and `running` (tasks still in flight, with the action each is on), what state is it in?'),
      criteria: {
        progressing: criterion('Recent entries show distinct new steps or results.'),
        waiting_external: criterion('Legitimately waiting on the user, a job, or an outside service.', {
          examples: ['One task has sat on a single action (an approval prompt, a long command) for the whole quiet stretch.'],
        }),
        looping: criterion('Repeating actions or messages with no new results.', {
          notFor: 'A single long-running action; that is waiting.',
        }),
        stalled: criterion('Nothing is running and nothing is happening.'),
        unrecoverable: criterion('Errors show the goal cannot proceed.'),
      },
    },
  };
}

/** Does each declared output deliver its description? One noul per key, each deciding its own output. */
export function producesQuestions(keys: string[]): Questions {
  const out: Questions = {};
  keys.forEach((_, i) => {
    out[`satisfied_${i}`] = {
      type: 'noul',
      instructions: instruction(`Does \`outputs[${i}].value\` deliver what \`outputs[${i}].description\` promises?`, {
        notFor: 'Values that are empty, placeholders, error messages, TODOs, or promises of later work.',
        examples: ['A reference to where the content is stored counts when the description allows it.'],
      }),
    };
  });
  return out;
}
