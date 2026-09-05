/**
 * Claim-shaped text detection.
 *
 * An agent's terminal report is its own account of what it did. Two objects
 * need a cheap, deterministic read on whether that account asserts an action
 * or an observed state without pointing at anything that proves it: Chat,
 * before a goal-less reply reaches the user, and ScrumMaster, before a
 * quick-dispatched task's result completes the goal unreviewed. Neither is a
 * verdict; both route the text to a second look.
 */

const CLAIM_SHAPE =
  /\b(verified|you'?re now|it'?s now|now on the|nav ?bar reads|on the live (?:window|deck|screen)|i'?ve (?:now|just)?|i have (?:now|just)|navigated|opened it|moved it|switched to|toggled|scrolled to|set it to|changed it to|updated the|refreshed the|should now|is now working|now works)\b/i;

/**
 * Things a report cites when it is grounded: a command and its exit code, a
 * verifier's verdict, an object id it spawned or changed, a file count, a
 * screenshot it looked at, a gate note. Any one of these means the claim is
 * anchored to something the runtime produced rather than to the agent's
 * narration.
 */
const EVIDENCE_SHAPE =
  /\b(exit(?:ed)?(?: code)? \d+|no new failures?|\d+ file\(s\) changed|spawned as [0-9a-f]{8}|objectId[:\s]|deployed as|screenshot (?:captured|shows|attached)|passed \d+|\d+ passed|verify(?:Command)?:? `|check(?:Command)?:? `|Gate:|baseline)\b/i;

/** True when the text asserts an action or state. */
export function looksLikeClaim(text: string): boolean {
  if (!text) return false;
  return CLAIM_SHAPE.test(text) || /\bdone\s*[—-]/i.test(text);
}

/** True when the text names something the runtime produced as proof. */
export function hasEvidenceMarkers(text: string): boolean {
  if (!text) return false;
  return EVIDENCE_SHAPE.test(text);
}

/**
 * A claim with nothing behind it. This is the shape worth a second look; a
 * claim beside its evidence is an ordinary report.
 */
export function looksLikeUngroundedClaim(text: string): boolean {
  return looksLikeClaim(text) && !hasEvidenceMarkers(text);
}
