/**
 * Fitness -- replay a candidate against what its object was recorded doing.
 *
 * The one check here is REPLAY. An invocation recording holds a handler
 * name, the arguments it was called with, every outbound `call()` the
 * handler made and what came back, and the value it returned. Replaying
 * runs the candidate's handler with those arguments, answers each outbound
 * call from the recording, and compares the result. A candidate that cannot
 * reproduce what the live object already did is contradicting evidence it
 * did not write and cannot edit.
 *
 * Nothing in here is a schema, a relation, or a declaration authored by the
 * generator. Nothing here calls an LLM or touches the network: every I/O the
 * candidate attempts is served from the recording through the caller's
 * Invoker, and an unrecorded call throws.
 *
 * What replay compares, and what it does NOT. It compares the candidate's
 * outbound `call()` targets/payloads and its RETURN value against the
 * recording. It does not assert that every recorded outbound call was in
 * fact made: a draft that silently drops a side effect (a Storage `set` it
 * no longer performs) still passes here. That is a deliberate scope line --
 * replay judges what the object answered, not the full multiset of effects.
 * Three more lines, for the same reason:
 * - The redaction scrub (below) is by field NAME, and it blinds the judge on
 *   more than credentials: the string value of ANY field whose name contains
 *   key, token, secret, passw, credential, session, signature, cookie or auth
 *   (`sortKey`, `sessionCount`, a plain `key`) compares REDACTED=REDACTED, so
 *   a wrong value there passes. The recording never held those values, so
 *   nothing here can compare them.
 * - A handler whose result depends on `this.data` cannot be reproduced by the
 *   control run (the harness's `data` is empty), so it is excluded, not judged.
 * - A handler that calls an object by an id it kept from an EARLIER
 *   invocation (a window id stored on `this` in show(), used by a later
 *   handler), or calls an object the registry cannot name and the invocation
 *   was not handed, is not judged: the recorder drops that invocation. Ids
 *   the same invocation got from a reply or its arguments (a window from
 *   createWindowAbject, a widget, a spawned child) are recorded as ids and
 *   replayed.
 *
 * Recorded values are stored REDACTED (secret-named fields scrubbed at record
 * time). The candidate's values are raw, so both sides get the identical
 * redaction before they are compared -- otherwise a `sessionId`/`apiKey`/
 * `*secret*` field could never match, and a faithful draft would be convicted
 * for a credential neither side is allowed to keep. Applying the same scrub
 * (rather than dropping the fields) keeps every field in the comparison; only
 * the scrubbed values are masked, on both sides.
 *
 * Honesty rule. `verified` says whether a check judged any actual
 * invocation outcome; a pass with `verified: false` means "nothing here
 * could be judged", never "this held", and its detail says why.
 */
import { canonicalJson, canonicalText } from './canonical.js';
import { redactBodyText } from '../core/redaction.js';

/** Canonical form of a JSON text with secret-named fields scrubbed. Recorded
 *  values were redacted at record time; candidate values are raw. The scrub
 *  is idempotent, so applying it to both sides makes a credential compare as
 *  REDACTED=REDACTED while every non-secret field is still compared for real. */
function redactedCanonical(text: string): string {
  return canonicalText(redactBodyText(text));
}

/** One outbound `call()` a handler made while it ran, as recorded. `target`
 *  is the registered NAME of the object addressed (the recorder resolves
 *  the live id it saw to that name, because ids die with their object), or,
 *  for an id the invocation was handed in its arguments or an earlier reply,
 *  that id: the replay hands the candidate the same text, so it addresses
 *  the same id. */
export interface RecordedCall {
  target: string;
  method: string;
  payloadText: string;
  replyText?: string;
  errorText?: string;
}

/** One recorded invocation of a handler on the live object. */
export interface InvocationRecording {
  method: string;
  argsText: string;
  calls: RecordedCall[];
  resultText?: string;
  errorText?: string;
  /** Something in this recording was cut at the size cap; it cannot be replayed faithfully. */
  truncated?: boolean;
  at?: number;
}

export interface Evidence { invocations: InvocationRecording[]; }

/** What the sandbox asks the host for when the candidate makes an outbound call. */
export interface CallStubRequest { target: string; method: string; payloadText: string; }
export type CallStubReply = { replyText: string } | { errorText: string };
export type CallStub = (req: CallStubRequest) => CallStubReply | undefined;

/** Runs `method` of a handler-map `source` with `args` as the message
 *  payload, every outbound call answered by `stub`. Resolves to the handler's
 *  return value (structured-clone data) or rejects with the handler's error. */
export type Invoker = (source: string, method: string,
                       args: Record<string, unknown>, stub: CallStub) => Promise<unknown>;

export interface ReplayResult {
  pass: boolean;
  /** True when at least one recording was actually replayed and compared. */
  verified: boolean;
  judged: number;
  reproduced: number;
  detail: string;
  /** First failures, for the refusal message. */
  failures: string[];
}

export interface EvidenceStrength {
  recordings: number;
  /** Recordings complete enough to replay (untruncated, returned a value, arguments parse). */
  usable: number;
  /** Usable recordings the LIVE source reproduces; recordings it cannot are
   *  non-deterministic or state-dependent and are not held against the draft. */
  deterministic?: number;
  detail: string;
}

export interface Verdict {
  /** False only when replay VERIFIED a contradiction. Never false for a lack of evidence. */
  pass: boolean;
  replay: ReplayResult;
  evidence: EvidenceStrength;
  /** The one line a loop's driver reads. */
  summary: string;
}

export interface FitnessOptions {
  /** The target's current source. Recordings the live source itself cannot
   *  reproduce are excluded: the evidence must convict the live object of
   *  nothing before it may convict the draft. */
  liveSource?: string;
  /** Replay at most this many recordings per method (most recent first). */
  maxPerMethod?: number;
  /** Epoch ms at which the caller stops waiting. Past it, no further
   *  recording is replayed and the verdict is "unverified", never a
   *  contradiction: an invocation cut off by the deadline is not the draft's
   *  doing. */
  deadline?: number;
}

const DEFAULT_MAX_PER_METHOD = 10;

function past(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

/** Recordings that can be replayed faithfully. */
export function usableRecordings(evidence: Evidence, maxPerMethod = DEFAULT_MAX_PER_METHOD): InvocationRecording[] {
  const perMethod = new Map<string, number>();
  const out: InvocationRecording[] = [];
  const newestFirst = [...evidence.invocations].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  for (const rec of newestFirst) {
    if (rec.truncated) continue;
    if (rec.resultText === undefined) continue; // threw, or returned something JSON could not carry
    if (!parses(rec.argsText) || !parses(rec.resultText)) continue;
    if (rec.calls.some(c => c.replyText === undefined && c.errorText === undefined)) continue;
    const n = perMethod.get(rec.method) ?? 0;
    if (n >= maxPerMethod) continue;
    perMethod.set(rec.method, n + 1);
    out.push(rec);
  }
  return out;
}

function parses(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Answer the candidate's outbound calls from one recording. Exact on target,
 *  method, and canonical payload: `{q: 1}` and `{q: 2}` are different
 *  questions, and a call with no payload matches only a recorded call with
 *  no payload, so omitting the payload is a miss, never a wildcard. */
export function stubFor(recording: InvocationRecording): CallStub {
  return req => {
    const want = redactedCanonical(req.payloadText);
    const hit = recording.calls.find(c =>
      c.target === req.target && c.method === req.method && redactedCanonical(c.payloadText) === want);
    if (!hit) return undefined;
    if (hit.errorText !== undefined) return { errorText: hit.errorText };
    return { replyText: hit.replyText! };
  };
}

async function replayOne(source: string, rec: InvocationRecording, invoke: Invoker): Promise<string | undefined> {
  let out: unknown;
  try {
    out = await invoke(source, rec.method, JSON.parse(rec.argsText) as Record<string, unknown>, stubFor(rec));
  } catch (err) {
    return `${rec.method}(${rec.argsText}) threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const got = redactedCanonical(canonicalJson(out === undefined ? null : out));
  const want = redactedCanonical(rec.resultText!);
  if (got !== want) {
    return `${rec.method}(${rec.argsText}) returned ${clip(got)} where the live object returned ${clip(want)}`;
  }
  return undefined;
}

function clip(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Replay recordings against `source`, stopping once `maxFailures` are found
 *  or `deadline` has passed. Each hanging invocation costs the invoker's full
 *  per-invocation deadline, so an early stop keeps a broken draft from
 *  burning the whole deploy budget: the refusal only prints the first few
 *  divergences anyway. */
export async function replay(source: string, recordings: InvocationRecording[], invoke: Invoker,
                             maxFailures = Number.POSITIVE_INFINITY, deadline?: number): Promise<ReplayResult> {
  if (recordings.length === 0) {
    return { pass: true, verified: false, judged: 0, reproduced: 0, failures: [],
      detail: 'no replayable recordings' };
  }
  const failures: string[] = [];
  let judged = 0;
  for (const rec of recordings) {
    if (past(deadline)) break;
    judged++;
    const failure = await replayOne(source, rec, invoke);
    if (failure) failures.push(failure);
    if (failures.length >= maxFailures) break;
  }
  const reproduced = judged - failures.length;
  return {
    pass: failures.length === 0,
    verified: true,
    judged,
    reproduced,
    failures,
    detail: failures.length === 0
      ? `${reproduced} recording${reproduced === 1 ? '' : 's'} reproduced`
      : `${failures.length} of ${judged} recording${judged === 1 ? '' : 's'} contradicted`,
  };
}

/** How many contradictions the candidate replay collects before stopping:
 *  the refusal message shows the first three. */
const MAX_REPORTED_FAILURES = 3;

/**
 * Judge a candidate source against recorded evidence.
 *
 * Order: keep the recordings that can be replayed at all; drop the ones the
 * live source cannot reproduce (when a live source is given); replay the
 * candidate against what remains. A verdict fails only on a verified
 * contradiction.
 */
export async function evaluate(candidate: { source: string }, evidence: Evidence,
                               invoke: Invoker, opts: FitnessOptions = {}): Promise<Verdict> {
  const total = evidence.invocations.length;
  let usable = usableRecordings(evidence, opts.maxPerMethod);
  const strength: EvidenceStrength = { recordings: total, usable: usable.length, detail: '' };

  if (usable.length === 0) {
    const why = total === 0 ? 'no invocations recorded for this object'
      : 'no recording is complete enough to replay (truncated, threw, or not JSON)';
    return unjudged(why, strength);
  }

  // The control: evidence the live source itself contradicts says nothing
  // about the draft. Time, randomness, state the recording did not carry, and
  // an outbound call the harness cannot address the way the handler did all
  // look like contradictions, and none of them is the draft's doing.
  if (opts.liveSource !== undefined) {
    const kept: InvocationRecording[] = [];
    for (const rec of usable) {
      if (past(opts.deadline)) break;
      if (await replayOne(opts.liveSource, rec, invoke) === undefined) kept.push(rec);
    }
    if (past(opts.deadline)) return unjudged('judgment abandoned: the caller\'s deadline passed during the control run', strength);
    strength.deterministic = kept.length;
    if (kept.length === 0) {
      return unjudged(`the live source reproduces none of its ${usable.length} recording${usable.length === 1 ? '' : 's'} — not deterministic, or not replayable by this harness`, strength);
    }
    usable = kept;
  }

  const rep = await replay(candidate.source, usable, invoke, MAX_REPORTED_FAILURES, opts.deadline);
  if (past(opts.deadline)) return unjudged('judgment abandoned: the caller\'s deadline passed during replay', strength);
  strength.detail = `${usable.length} recording${usable.length === 1 ? '' : 's'} replayed`;
  return finish(rep.pass, rep, strength);
}

/** A pass that judged nothing, saying why. */
function unjudged(why: string, strength: EvidenceStrength): Verdict {
  strength.detail = why;
  return finish(true, { pass: true, verified: false, judged: 0, reproduced: 0, failures: [], detail: why }, strength);
}

function finish(pass: boolean, rep: ReplayResult, strength: EvidenceStrength): Verdict {
  const verdict: Verdict = { pass, replay: rep, evidence: strength, summary: '' };
  verdict.summary = summarizeVerdict(verdict);
  return verdict;
}

/** A verdict that judged no evidence must not read like one that judged
 *  plenty, and a pass must say how much of the evidence the control set
 *  aside: "1 recording reproduced" reads the same for 1 of 1 and 1 of 50. */
export function summarizeVerdict(v: Verdict): string {
  if (!v.pass) return `fitness: FAIL — ${v.replay.detail}: ${v.replay.failures[0] ?? ''}`;
  if (!v.replay.verified) return `fitness: unverified — ${v.replay.detail}`;
  const { usable, deterministic } = v.evidence;
  const excluded = deterministic !== undefined && deterministic < usable
    ? ` (${usable - deterministic} of ${usable} excluded by the control)`
    : '';
  return `fitness: PASS — ${v.replay.detail}${excluded}`;
}
