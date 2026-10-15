/**
 * FitnessJudge - the judge is an abject.
 *
 * Asked `judge({source, typeId, liveSource?})`, it loads the recorded
 * invocations the CassetteRecorder keeps under `invocations:<typeId>`,
 * replays them against `source` on a worker thread (protocol/fitness.ts),
 * and answers with a Verdict. It holds no state between calls, so it can be
 * introspected, restarted, cloned, or replaced like any other object, and
 * ObjectCreator reaches it by message rather than by import.
 *
 * What it defends against is an honest-but-wrong draft, not an adversarial
 * one. The verdict is computed from Storage and the draft's replayed
 * behaviour, and that behaviour is the candidate's own returned value,
 * produced by candidate code on a worker that is a deadline and a heap cap,
 * not a confidentiality boundary (see protocol/sandbox-invoker.ts). It is not
 * built to contain a hostile draft.
 *
 * `judge` answers any caller on the bus; it does not gate on the caller's
 * typeId (the recordings it reads already sit in global Storage, readable by
 * any object that asks Storage). Judgments run one at a time: each spawns a
 * worker with a 256 MB heap cap, so concurrent asks queue behind each other
 * instead of multiplying workers. A request may carry the caller's
 * `deadline`: a judgment whose deadline passed while it waited in the queue
 * answers "unverified" when its turn comes, without running, and a running
 * one stops its worker and answers "unverified", so a caller that gave up
 * does not hold the queue for the next one.
 *
 * What it does NOT do: hold a verdict for later, or bind one to a digest.
 * Deploy ops ask about the exact source and target they are deploying, at
 * the moment they deploy (mempko/abject#11: evaluating inside deploy removes
 * the verdict-carrying class of bug entirely).
 *
 * Honesty: a verdict fails only on a verified contradiction with the
 * recording. No recordings, recordings that could not be read, a target
 * that is not yet an object (a spawn), recordings the live source itself
 * cannot reproduce, or a caller's deadline that passed all yield a pass
 * labelled unverified with the reason, never a refusal.
 */

import { AbjectId, AbjectMessage, TypeId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { requireNonEmpty } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { evaluate, type Verdict, type InvocationRecording } from '../protocol/fitness.js';
import { buildSandboxInvoker } from '../protocol/sandbox-invoker.js';

const log = new Log('FITNESS-JUDGE');

const FITNESS_JUDGE_INTERFACE = 'abjects:fitness-judge';
export const FITNESS_JUDGE_ID = 'abjects:fitness-judge' as AbjectId;

export interface JudgeRequest {
  /** The candidate handler-map source. */
  source: string;
  /** Durable type of the object the source is meant for. Absent for an object that does not exist yet. */
  typeId?: TypeId;
  /** The target's current source; recordings it cannot reproduce are not held against the draft. */
  liveSource?: string;
  /** Epoch ms at which the caller stops waiting for the answer. */
  deadline?: number;
}

export class FitnessJudge extends Abject {
  private storageId?: AbjectId;
  /** Tail of the one-at-a-time queue of judgments. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    super({
      manifest: {
        name: 'FitnessJudge',
        description:
          'Judges a candidate source for a generated object by replaying the object\'s recorded invocations against it. Fails only on a verified contradiction; reports unverified when there is nothing to judge. Asked by ObjectCreator inside deploy.',
        version: '1.0.0',
        interface: {
          id: FITNESS_JUDGE_INTERFACE,
          name: 'FitnessJudge',
          description: 'Evidence-based judgment of generated source',
          methods: [
            {
              name: 'judge',
              description: 'Replay the recorded invocations of typeId against source. Returns a Verdict: {pass, replay, evidence, summary}. pass is false only when a recording was verifiably contradicted.',
              parameters: [
                { name: 'source', type: { kind: 'primitive', primitive: 'string' }, description: 'Candidate handler-map source' },
                { name: 'typeId', type: { kind: 'primitive', primitive: 'string' }, description: 'Durable typeId of the target object (omit for a new object)', optional: true },
                { name: 'liveSource', type: { kind: 'primitive', primitive: 'string' }, description: 'The target\'s current source, used to exclude non-deterministic recordings', optional: true },
                { name: 'deadline', type: { kind: 'primitive', primitive: 'number' }, description: 'Epoch ms at which the caller stops waiting; past it the judgment stops and answers unverified', optional: true },
              ],
              returns: { kind: 'object', properties: {
                pass: { kind: 'primitive', primitive: 'boolean' },
                summary: { kind: 'primitive', primitive: 'string' },
                replay: { kind: 'object' },
                evidence: { kind: 'object' },
              } },
            },
          ],
        },
        tags: ['system', 'evidence', 'judge'],
      },
    });
  }

  protected override async onInit(): Promise<void> {
    this.on('judge', async (msg: AbjectMessage) => this.judge(msg.payload as JudgeRequest));
  }

  judge(req: JudgeRequest): Promise<Verdict> {
    const run = this.queue.then(() => this.judgeNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async judgeNow(req: JudgeRequest): Promise<Verdict> {
    requireNonEmpty(req.source, 'source');
    if (!req.typeId) {
      return unverified('no typeId: an object that does not exist yet has no recorded history');
    }
    if (req.deadline !== undefined && Date.now() >= req.deadline) {
      return unverified('judgment abandoned: the caller\'s deadline passed while it was queued');
    }
    const loaded = await this.loadRecordings(req.typeId);
    if (typeof loaded === 'string') return unverified(loaded);
    // One worker per judgment: the invoker serialises invocations on its
    // worker, and two judgments must not share one. ~15ms to spawn.
    const invoker = buildSandboxInvoker();
    // Just past the caller's deadline the worker is stopped, which ends the
    // invocation in flight; evaluate() sees the deadline passed and answers
    // unverified instead of counting that invocation against the draft.
    const stop = req.deadline === undefined ? undefined
      : setTimeout(() => invoker.dispose(), Math.min(Math.max(0, req.deadline - Date.now()) + 50, 2 ** 31 - 1));
    try {
      return await evaluate({ source: req.source }, { invocations: loaded }, invoker,
        { liveSource: req.liveSource, deadline: req.deadline });
    } finally {
      clearTimeout(stop);
      invoker.dispose();
    }
  }

  /** What the recorder has kept for this type, or why it could not be read.
   *  A missing key is no evidence; absent or failing Storage is reported as
   *  such, so the verdict does not claim nothing was recorded. */
  private async loadRecordings(typeId: TypeId): Promise<InvocationRecording[] | string> {
    this.storageId ??= (await this.discoverDep('Storage')) ?? undefined;
    if (!this.storageId) return 'recordings unreadable: no Storage on the bus';
    try {
      const raw = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: `invocations:${typeId}` }), 5000);
      return Array.isArray(raw) ? raw.filter(isRecording) : [];
    } catch (err) {
      // Storage may have restarted under a new id; drop the cached one so the
      // next judgment re-discovers it instead of every verdict staying
      // silently "unverified" until the judge itself restarts.
      this.storageId = undefined;
      log.warn(`recordings unreadable for ${typeId}`, err);
      return `recordings unreadable: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
    }
  }
}

function isRecording(v: unknown): v is InvocationRecording {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.method === 'string' && typeof r.argsText === 'string' && Array.isArray(r.calls);
}

function unverified(why: string): Verdict {
  return {
    pass: true,
    replay: { pass: true, verified: false, judged: 0, reproduced: 0, failures: [], detail: why },
    evidence: { recordings: 0, usable: 0, detail: why },
    summary: `fitness: unverified — ${why}`,
  };
}
