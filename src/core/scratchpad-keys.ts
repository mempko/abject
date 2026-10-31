/**
 * Which goal scratchpad keys are the system's own records rather than results.
 *
 * The scratchpad holds both: task results and findings the user's answer is
 * built from, and the runtime's records about how the work went (learning
 * evidence, routing, conversation context, the planner's execution record).
 * The records are for reviewers and planners. Handed to whoever writes the
 * user's answer, they turn into process narration ("the cancelled lane",
 * "round 1 was replanned") in place of the answer.
 */

/** Prefixes of keys the runtime writes about the work, not as its results. */
export const INTERNAL_SCRATCHPAD_PREFIXES = ['learning/', 'routing/', 'context/', 'scrum/', 'goal/assumptions'] as const;

/** True for a key that records how the work went rather than what it found. */
export function isInternalScratchpadKey(key: string): boolean {
  return INTERNAL_SCRATCHPAD_PREFIXES.some(prefix => key.startsWith(prefix));
}
