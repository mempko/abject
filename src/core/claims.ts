/**
 * Claim-shaped text detection.
 *
 * An agent's terminal report is its own account of what it did. Two objects
 * need a cheap, deterministic read on whether that account asserts an action
 * or an observed state without pointing at anything that proves it: Chat,
 * before a goal-less reply reaches the user, and ScrumMaster, before a
 * quick-dispatched task's result completes the goal unreviewed. Neither is a
 * verdict; both route the text to a second look.
 *
 * Assertions come in both directions — that something happened, and that
 * something is not there — and both are claims about live state that no
 * amount of reasoning can settle from an empty conversation.
 */

const CLAIM_SHAPE =
  /\b(verified|you'?re now|it'?s now|now on the|nav ?bar reads|on the live (?:window|deck|screen)|i'?ve (?:now|just)?|i have (?:now|just)|navigated|opened it|moved it|switched to|toggled|scrolled to|set it to|changed it to|updated the|refreshed the|should now|is now working|now works)\b/i;

/**
 * The same assertion in the negative: that something is absent, missing, or
 * beyond the system's reach. This is a claim about live state exactly as much
 * as "I opened it" is, and it cannot be known without looking either — a name
 * lookup that missed says nothing about what the system can do, because a
 * registered name cannot see a capability acquired after registration.
 *
 * It is also the more costly direction to get wrong. An unfounded positive
 * claim wastes a turn and is usually contradicted by the next one; an
 * unfounded negative closes the conversation, tells the user a tool they have
 * does not exist, and invites them to go and re-explain their own system.
 */
/**
 * The things this system is made of. A negation has to be ABOUT one of these
 * to be a capability denial — "there are no blocking issues in the diff" is an
 * ordinary finding and reporting it should cost nothing, while "there is no
 * agent by that name" is a claim Chat cannot make from an empty turn.
 */
const SYSTEM_ENTITY =
  String.raw`(?:abject|object|agent|skill|tool|server|service|capability|integration|connector|plugin|registry|handler|mcp)s?`;

const ABSENCE_SHAPE = new RegExp([
  // A lookup that failed, said as a conclusion about the system.
  String.raw`\b(?:could\s?n'?t|can'?t|cannot|unable to|failed to)\s+(?:find|locate|reach)\s+(?:a|an|any|the)?\s*[^.\n]{0,30}\b${SYSTEM_ENTITY}\b`,
  // The same, with the search itself left indefinite. "anything"/"anyone"
  // only — "couldn't find any blocking issues" is a finding, not a denial.
  String.raw`\b(?:could\s?n'?t|can'?t|cannot|unable to|failed to)\s+(?:find|locate|reach)\s+(?:anything|anyone)\b`,
  String.raw`\bnothing is (?:registered|installed|available|connected|enabled)\b`,
  // "there is no <entity>", within a clause of the negation.
  String.raw`\bthere(?:'s| is| are)\s+(?:no|not any)\b[^.\n]{0,40}\b${SYSTEM_ENTITY}\b`,
  // Unambiguous on their own — these phrasings are only ever about identity.
  String.raw`\bno\s+such\b`,
  String.raw`\bby that name\b`,
  String.raw`\bno\s+registered\b`,
  // State denials: installed / registered / connected are system words.
  String.raw`\b(?:is|are|it'?s)\s?n'?t\s+(?:registered|installed|available|running|connected|enabled)\b`,
  String.raw`\bnot\s+(?:registered|installed|connected|enabled)\b`,
  String.raw`\bdoes\s?n'?t\s+(?:exist|appear to exist)\b`,
  String.raw`\bI don'?t have (?:access to|a way to)\b`,
].join('|'), 'i');

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

/** True when the text asserts that something is absent or out of reach. */
export function looksLikeAbsenceClaim(text: string): boolean {
  if (!text) return false;
  return ABSENCE_SHAPE.test(text);
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

/**
 * A reply that only says the work happened: "Done.", "OK", "Task complete".
 * No content, no figures, nothing the user asked for.
 */
const ACKNOWLEDGEMENT_SHAPE =
  /^(?:ok(?:ay)?|done|finished|complete[d]?|success(?:ful)?|(?:task|all|that'?s|it'?s) (?:is )?(?:done|complete[d]?|finished|set)|no problem|sure)[.!]*$/i;

/**
 * True when a result carries no answer: empty, a bare acknowledgement, or a
 * few words with no figure in them. A worker that stored its findings
 * elsewhere and closed with "Done." has delivered nothing to the user, and
 * the text alone cannot tell "Done." from an answer, so the shape has to.
 * Deliberately loose on the short side: a three-word reply to a real
 * question is re-synthesized from the goal's data, which costs one cheap
 * call and never loses the answer.
 */
export function looksLikeBareAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (ACKNOWLEDGEMENT_SHAPE.test(trimmed)) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length <= 3 && !/\d/.test(trimmed);
}

// ── Decision-model reading (src/core/decision-questions.ts reportQuestions) ──

/**
 * What a decision model read in a report, from reportQuestions(). The regexes
 * above stay the fallback: this reading is richer (it sees paraphrase,
 * promises, and lookup answers the shapes misjudge) but only as good as the
 * model that produced it, so callers OR it with the shapes until a site's
 * ledger shows it calibrated.
 */
export interface ReportVerdict {
  /** Asserts an action or live state with nothing showing it happened. */
  ungrounded: boolean;
  /** Tells the reader something is missing, not installed, or out of reach. */
  absence: boolean;
  /** Only acknowledges completion; the content itself is missing. */
  bareAck: boolean;
  /** Promises to act with nothing set in motion. */
  promise: boolean;
  /** Clearly none of the above: an answer, a question, or conversation. */
  clean: boolean;
  /** The report kind and its probability, for logs. */
  kind: string;
  kindP: number;
}

export function readReportVerdict(
  answers: Record<string, { type: string; noul?: number; choice?: string; probabilities?: Record<string, number> }>,
): ReportVerdict | undefined {
  const noul = (id: string): number | undefined => (answers[id]?.type === 'noul' ? answers[id].noul : undefined);
  const kindAnswer = answers.report_kind;
  const action = noul('asserts_action');
  const absence = noul('asserts_absence');
  const evidence = noul('cites_evidence');
  if (action === undefined && absence === undefined && !kindAnswer) return undefined;
  const kind = kindAnswer?.choice ?? 'unknown';
  const kindP = kindAnswer?.probabilities?.[kind] ?? 0;
  const ungrounded = ((action ?? 0) >= 0.6 && (evidence ?? 1) < 0.4) || (kind === 'ungrounded_claim' && kindP >= 0.6);
  const absent = (absence ?? 0) >= 0.6;
  const bareAck = kind === 'bare_ack' && kindP >= 0.7;
  const promise = kind === 'promise_without_action' && kindP >= 0.6;
  const clean = !ungrounded && !absent && !bareAck && !promise
    && (action ?? 1) < 0.2 && (absence ?? 1) < 0.2
    && ['answer', 'grounded_action', 'question_to_user', 'conversation'].includes(kind) && kindP >= 0.6;
  return { ungrounded, absence: absent, bareAck, promise, clean, kind, kindP };
}
