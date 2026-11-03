/**
 * JobManager — universal headless job execution service.
 *
 * Any abject can submit code-execution jobs. Jobs run sequentially in FIFO
 * order. The manager broadcasts events for observability (JobBrowser, Chat).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as contractRequire, requireNonEmpty } from '../core/contracts.js';
import { Sandbox, SandboxTimeLimitError } from '../core/sandbox.js';
import { Log } from '../core/timed-log.js';
import { levenshtein } from './source-diff.js';
import { isReadOperation } from '../core/surprise.js';
import { isPrivatePayload, shown, PRIVATE_TEXT } from '../core/privacy.js';

const log = new Log('JobManager');

/** An id is a UUID; anything else a job passes as a recipient is a name. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JOBMANAGER_INTERFACE: InterfaceId = 'abjects:job-manager';

// The sandbox (core/sandbox.ts) runs the code; JobManager supplies the helpers
// (call, dep, find, ask, decide, progress) and the limits.

/** Longest a stretch of job code may run without pausing. */
const JOB_SLICE_MS = 10_000;
/**
 * A day: how long a job waits on one call, and the longest inactivity limit a
 * submitter may ask for. Jobs wait on other jobs, which wait on others in
 * turn, so the wait has to cover the whole chain below it.
 */
const JOB_WAIT_MS = 86_400_000;

export interface Job {
  id: string;
  queue: string;
  description: string;
  code: string;
  callerId: AbjectId;
  taskId?: string;
  /**
   * Set only for AgentAbject's own observe/think/act dispatch jobs (checked
   * at submit): AgentAbject holds a check step's action to reads before it
   * hands it over, so these are exempt from the read-only rule below.
   */
  runtimeStep?: boolean;
  /**
   * Message id of the submitJob request. Carried into the direct jobFailed
   * caller notification so the caller can reject exactly the pending
   * request this job answers, instead of every pending JobManager request.
   */
  requestMessageId?: string;
  /** Extra values bound into the sandbox context alongside call/dep/find. */
  context?: Record<string, unknown>;
  /** Stop the job when it goes this long without progress (ms). Unset: no limit. */
  timeoutMs?: number;
  /**
   * Work for a private conversation's goal: its description, code and result
   * reach only its submitter, AgentAbject and GoalManager, never a log, and
   * the job is dropped once its answer is delivered.
   */
  private?: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
}

interface QueueState {
  name: string;
  queue: string[];
  processing: boolean;
  currentJobId?: string;
}

/**
 * A running job's view of its own calls, so progress from a callee keeps its
 * inactivity limit from firing. Kept per job, never per queue: a job stopped
 * at its limit can still have calls in flight while the next one runs.
 */
interface RunningJob {
  /** Objects this job is waiting on, with how many calls to each. */
  awaiting: Map<AbjectId, number>;
  /** The job made progress: restart its inactivity limit. */
  touch(): void;
}

export interface JobResult {
  jobId: string;
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

/**
 * Names the job sandbox reserves for its built-ins. Caller-supplied context
 * entries with these keys are silently dropped on submit.
 */
const RESERVED_CONTEXT_KEYS = new Set<string>([
  'ask', 'decide', 'call', 'dep', 'find', 'id', 'progress', 'console',
]);

/** Besides its submitter, the built-in objects that may see a private job. */
const PRIVATE_JOB_READERS = ['AgentAbject', 'GoalManager'] as const;

export class JobManager extends Abject {
  private invocationContexts = new Map<string,{callerId?:AbjectId;taskId?:string;target:AbjectId}>();
  private jobs: Map<string, Job> = new Map();
  private queues: Map<string, QueueState> = new Map();
  private static readonly DEFAULT_QUEUE = 'default';
  private jobCounter = 0;
  private pendingResolvers: Map<string, (job: Job) => void> = new Map();
  private running: Map<string, RunningJob> = new Map();
  private consoleId?: AbjectId;
  /** Whether an agent task is private, by AgentAbject's word; bounded, a task's privacy never changes. */
  private taskPrivacy = new Map<string, boolean>();

  constructor() {
    super({
      manifest: {
        name: 'JobManager',
        description:
          'Universal headless job execution service. Any abject can submit code-execution jobs. Sequential FIFO queue with event broadcasting.',
        version: '1.0.0',
        interface: {
            id: JOBMANAGER_INTERFACE,
            name: 'JobManager',
            description: 'Job execution service',
            methods: [
              {
                name: 'submitJob',
                description: 'Queue a job and block until it completes. Returns the job result.',
                parameters: [
                  { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable job description' },
                  { name: 'code', type: { kind: 'primitive', primitive: 'string' }, description: 'JavaScript code to execute' },
                  { name: 'queue', type: { kind: 'primitive', primitive: 'string' }, description: 'Named queue for concurrent execution (default: "default")', optional: true },
                  { name: 'timeoutMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Stop the job when it goes this long without progress: no call answered, no progress reported. At most a day; unset: no limit.', optional: true },
                  { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The agent task this job works for. When that task is a read-only check step (AgentAbject getTaskStatus readOnly), the job may only make calls that read.', optional: true },
                  { name: 'runtimeStep', type: { kind: 'primitive', primitive: 'boolean' }, description: 'AgentAbject only: the job is its own observe/think/act dispatch for taskId.', optional: true },
                  { name: 'private', type: { kind: 'primitive', primitive: 'boolean' }, description: 'The job works for a private conversation (also when AgentAbject getTaskStatus says taskId is private): nothing of it is logged, listings show it only to its submitter, AgentAbject and GoalManager, its LLM calls are private, and it is dropped once delivered.', optional: true },
                ],
                returns: { kind: 'reference', reference: 'JobResult' },
              },
              {
                name: 'listJobs',
                description: 'Return all jobs, most recent first. A private job is listed only to its submitter, AgentAbject and GoalManager.',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'Job' } },
              },
              {
                name: 'getJob',
                description: 'Return a single job by ID (null for a private job asked by anyone but its submitter, AgentAbject or GoalManager).',
                parameters: [
                  { name: 'jobId', type: { kind: 'primitive', primitive: 'string' }, description: 'Job ID' },
                ],
                returns: { kind: 'reference', reference: 'Job' },
              },
              {
                name: 'cancelJob',
                description: 'Cancel a queued (not running) job.',
                parameters: [
                  { name: 'jobId', type: { kind: 'primitive', primitive: 'string' }, description: 'Job ID' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'clearHistory',
                description: 'Remove completed and failed jobs from history.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listQueues',
                description: 'Return names of all active queues.',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'forgetPrivateGoal',
                description: 'A private goal has ended: drop every job of its tasks (queued ones are cancelled). Taken from GoalManager only.',
                parameters: [
                  { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'The private root goal' },
                  { name: 'taskIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Every task of the goal and its children' },
                ],
                returns: { kind: 'object', properties: { dropped: { kind: 'primitive', primitive: 'number' } } },
              },
            ],
          },
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.consoleId = await this.discoverDep('Console') ?? undefined;
  }

  private async log(level: string, message: string, data?: unknown): Promise<void> {
    if (!this.consoleId) return;
    try {
      this.send(
        request(this.id, this.consoleId, level, { message, data })
      );
    } catch { /* logging should never break the caller */ }
  }

  private getOrCreateQueue(name: string): QueueState {
    let q = this.queues.get(name);
    if (!q) {
      q = { name, queue: [], processing: false };
      this.queues.set(name, q);
    }
    return q;
  }

  private setupHandlers(): void {
    this.on('getInvocationContext', msg=>{
      const context=this.invocationContexts.get((msg.payload as {messageId:string}).messageId);
      return context?.target===msg.routing.from?{callerId:context.callerId,taskId:context.taskId}:null;
    });
    // NOTE: no custom 'progress' handler here. A previous version registered
    // one to forward heartbeats to job submitters, but Abject.init() registers
    // the base 'progress' handler AFTER the constructor runs setupHandlers(),
    // and on() is last-write-wins — so it was silently dead code. The base
    // handler now covers both needs: it resets our outbound call timers and
    // bubbles progress to every requester still waiting on a deferred reply
    // (which is exactly the submitJob callers tracked per queue).

    this.on('submitJob', async (msg: AbjectMessage) => {
      const { description, code, queue: queueName, context: userContext, timeoutMs } = msg.payload as {
        description: string; code: string; queue?: string;
        context?: Record<string, unknown>; timeoutMs?: number;
      };
      requireNonEmpty(description, 'description');
      requireNonEmpty(code, 'code');
      const taskId = typeof (msg.payload as any)?.taskId === 'string' ? (msg.payload as any).taskId as string : undefined;
      // Private work: flagged by its submitter, or a private task by AgentAbject's word.
      const isPrivate = isPrivatePayload(msg.payload) || (!!taskId && await this.taskIsPrivate(taskId));

      // Refuse at once what could never run, with the reason.
      try {
        Sandbox.checkSource(code, 'body');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.info(`Rejected job from ${msg.routing.from}: ${shown(reason, isPrivate)}`);
        throw new Error(`Job code rejected: ${reason}`);
      }

      // User-supplied context values cannot shadow built-in names.
      let sanitisedContext: Record<string, unknown> | undefined;
      if (userContext && typeof userContext === 'object') {
        sanitisedContext = {};
        for (const [k, v] of Object.entries(userContext)) {
          if (RESERVED_CONTEXT_KEYS.has(k)) continue;
          sanitisedContext[k] = v;
        }
      }

      const callerId = msg.routing.from;
      const jobId = `job-${++this.jobCounter}`;
      // The exemption is AgentAbject's alone; the flag from anyone else is ignored.
      const runtimeStep = !!taskId && (msg.payload as { runtimeStep?: unknown }).runtimeStep === true
        && await this.isBuiltInCaller(callerId, ['AgentAbject']);
      const resolvedQueue = queueName ?? JobManager.DEFAULT_QUEUE;

      const job: Job = {
        id: jobId,
        queue: resolvedQueue,
        description,
        code,
        callerId,
        taskId,
        ...(runtimeStep ? { runtimeStep: true } : {}),
        requestMessageId: msg.header.messageId,
        context: sanitisedContext,
        ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeoutMs: Math.min(timeoutMs, JOB_WAIT_MS) } : {}),
        ...(isPrivate ? { private: true } : {}),
        status: 'queued',
        queuedAt: Date.now(),
      };

      this.jobs.set(jobId, job);
      const q = this.getOrCreateQueue(resolvedQueue);
      q.queue.push(jobId);

      // Broadcast jobQueued to dependents (JobBrowser); a private job's carries no text.
      this.changed('jobQueued', isPrivate
        ? { jobId, description: PRIVATE_TEXT, queue: resolvedQueue, position: q.queue.length, private: true }
        : { jobId, description, queue: resolvedQueue, position: q.queue.length });

      // Create a Promise that resolves when the job finishes
      const jobDone = new Promise<Job>((resolve) => {
        this.pendingResolvers.set(jobId, resolve);
      });

      // Kick off queue processing (fire-and-forget)
      this.processQueue(resolvedQueue);

      // Send the reply when the job completes (non-blocking)
      jobDone.then(async (finished) => {
        try {
          this.sendDeferredReply(msg, {
            jobId: finished.id,
            status: finished.status,
            result: finished.result,
            error: finished.error,
          } as JobResult);
        } catch (err) {
          this.log('warn', `Deferred reply for ${finished.id} failed (caller may be gone): ${err instanceof Error ? err.message : String(err)}`);
        }
        // A private job is kept only until its answer is delivered.
        if (finished.private) this.jobs.delete(finished.id);
      });

      // Return DEFERRED_REPLY to suppress auto-reply and free the processing loop
      return DEFERRED_REPLY;
    });

    this.on('listJobs', async (msg: AbjectMessage) => {
      const allJobs = Array.from(this.jobs.values());
      allJobs.sort((a, b) => b.queuedAt - a.queuedAt);
      if (!allJobs.some(j => j.private)) return allJobs;
      // Private jobs are listed to their submitter, AgentAbject and GoalManager only.
      if (await this.isBuiltInCaller(msg.routing.from, PRIVATE_JOB_READERS)) return allJobs;
      return allJobs.filter(j => !j.private || j.callerId === msg.routing.from);
    });

    this.on('getJob', async (msg: AbjectMessage) => {
      const { jobId } = msg.payload as { jobId: string };
      const job = this.jobs.get(jobId);
      if (job && !(await this.seesJob(job, msg.routing.from))) return null;
      return job ?? null;
    });

    this.on('cancelJob', async (msg: AbjectMessage) => {
      const { jobId } = msg.payload as { jobId: string };
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'queued') return false;
      if (!(await this.seesJob(job, msg.routing.from))) return false;
      this.log('info', `cancelJob ${jobId} (${shown(job.description, job.private)})`);

      // Remove from the job's named queue
      const q = this.queues.get(job.queue);
      if (q) {
        const idx = q.queue.indexOf(jobId);
        if (idx >= 0) q.queue.splice(idx, 1);
      }

      job.status = 'failed';
      job.error = 'Cancelled';
      job.completedAt = Date.now();

      // Resolve pending promise
      const resolver = this.pendingResolvers.get(jobId);
      if (resolver) {
        this.pendingResolvers.delete(jobId);
        resolver(job);
      }

      this.changed('jobFailed', job.private
        ? { jobId, description: PRIVATE_TEXT, queue: job.queue, error: 'Cancelled', private: true }
        : { jobId, description: job.description, queue: job.queue, error: 'Cancelled' });
      return true;
    });

    // A private goal ended: GoalManager names its tasks, and their jobs go.
    this.on('forgetPrivateGoal', async (msg: AbjectMessage) => {
      contractRequire(await this.isBuiltInCaller(msg.routing.from, ['GoalManager']),
        'JobManager takes forgetPrivateGoal from GoalManager only');
      const { taskIds } = msg.payload as { goalId?: string; taskIds?: string[] };
      return { dropped: this.forgetPrivateTasks(new Set(Array.isArray(taskIds) ? taskIds : [])) };
    });

    this.on('clearHistory', async () => {
      const toRemove: string[] = [];
      for (const [jobId, job] of this.jobs) {
        if (job.status === 'completed' || job.status === 'failed') {
          toRemove.push(jobId);
        }
      }
      for (const jobId of toRemove) {
        this.jobs.delete(jobId);
      }
      this.changed('historyCleared', {});
      return true;
    });

    this.on('listQueues', async () => {
      return Array.from(this.queues.keys());
    });
  }

  private async processQueue(queueName: string): Promise<void> {
    const q = this.queues.get(queueName);
    if (!q || q.processing || q.queue.length === 0) return;
    q.processing = true;

    try {
      while (q.queue.length > 0) {
        const jobId = q.queue.shift()!;
        const job = this.jobs.get(jobId);
        if (!job) continue;

        job.status = 'running';
        job.startedAt = Date.now();
        q.currentJobId = jobId;

        // A private job's events and log lines carry no text of it.
        this.changed('jobStarted', job.private
          ? { jobId, description: PRIVATE_TEXT, queue: job.queue, private: true }
          : { jobId, description: job.description, queue: job.queue });
        await this.log('info', `Job started: ${shown(job.description, job.private)}`, { jobId, queue: job.queue });

        try {
          const result = await this.executeJob(job);
          job.status = 'completed';
          job.result = result;
          if (job.private) {
            this.changed('jobCompleted', { jobId, description: PRIVATE_TEXT, queue: job.queue, private: true });
            await this.log('info', `Job completed: ${PRIVATE_TEXT}`, { jobId, queue: job.queue });
          } else {
            this.changed('jobCompleted', { jobId, description: job.description, queue: job.queue, result });
            await this.log('info', `Job completed: ${job.description}`, { jobId, queue: job.queue, result });
          }
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          if (job.private) {
            this.changed('jobFailed', { jobId, description: PRIVATE_TEXT, queue: job.queue, error: PRIVATE_TEXT, requestMessageId: job.requestMessageId, private: true });
            await this.log('error', `Job failed: ${PRIVATE_TEXT}`, { jobId, queue: job.queue });
          } else {
            this.changed('jobFailed', { jobId, description: job.description, queue: job.queue, error: job.error, requestMessageId: job.requestMessageId });
            await this.log('error', `Job failed: ${job.description}`, { jobId, queue: job.queue, error: job.error });
          }

          // Notify the caller directly so it can recover immediately
          // instead of waiting for its own request timeout to fire.
          if (job.callerId) {
            try {
              this.send(event(this.id, job.callerId, 'jobFailed', {
                jobId,
                description: job.description,
                queue: job.queue,
                error: job.error,
                requestMessageId: job.requestMessageId,
              }));
            } catch { /* caller may be gone */ }
          }
        }

        job.completedAt = Date.now();
        q.currentJobId = undefined;

        // Resolve pending promise for this job
        const resolver = this.pendingResolvers.get(jobId);
        if (resolver) {
          this.pendingResolvers.delete(jobId);
          resolver(job);
        }
      }
    } finally {
      q.processing = false;
      // Clean up empty queues to avoid accumulation
      if (q.queue.length === 0) {
        this.queues.delete(queueName);
      }
    }
  }

  /**
   * What to say when a name matches nothing.
   *
   * The failure that motivated this spent four agent steps listing the
   * registry to work out what the object was "really" called. Answering that
   * question in the error costs one message and saves the search.
   */
  private async unknownRecipientError(name: string): Promise<string> {
    let suggestions = '';
    try {
      const regId = await this.resolveRegistryId();
      if (regId) {
        // Registry search matches substrings, which is exactly what a typo is
        // not: "GoalManger" contains no substring of "GoalManager" long enough
        // to hit. So rank the registered names by edit distance instead —
        // a misspelling is the case this error exists to answer.
        const listed = await this.request<Array<{ name?: string }>>(
          request(this.id, regId, 'list', {}), 10000,
        );
        const names = [...new Set((listed ?? []).map(o => o.name).filter((n): n is string => !!n))];
        const lower = name.toLowerCase();
        const near = names
          .map(n => ({ n, d: levenshtein(lower, n.toLowerCase()) }))
          // Half the name's length is loose enough to catch a dropped letter or
          // a wrong case, tight enough that an unrelated object never appears.
          .filter(c => c.d <= Math.max(2, Math.floor(name.length / 2)))
          .sort((a, b) => a.d - b.d)
          .slice(0, 3)
          .map(c => c.n);
        if (near.length > 0) suggestions = ` Did you mean: ${near.join(', ')}?`;
        else if (names.length > 0) suggestions = ` Registered: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}.`;
      }
    } catch { /* a registry that will not answer must not mask the real error */ }
    return (
      `call() could not find an object named "${name}".${suggestions} ` +
      `Pass a registered object name or an id — both work here.`
    );
  }

  /**
   * Run one job in a sandbox of its own, under three limits: a stretch of
   * code that runs past JOB_SLICE_MS is stopped; a job waiting on something
   * nothing can deliver (no call outstanding, no timer set) fails at once;
   * and a job with a `timeoutMs` is stopped when it goes that long without
   * progress. Whichever way it ends, its sandbox is disposed, so its timers
   * and late answers die with it.
   */
  private async executeJob(job: Job): Promise<unknown> {
    const callerId = job.callerId;
    const userContext = job.context;
    log.info(`Executing job code (queue: ${job.queue}):\n${shown(job.code, job.private)}`);

    // Names resolved during this job. Scoped to the run rather than to the
    // object: an id belongs to one object for its lifetime, but a respawn
    // hands out a new one, and a cache outliving the job would eventually
    // address something that no longer exists.
    const resolvedNames = new Map<string, AbjectId>();

    /**
     * Turn whatever the job passed as a recipient into an address.
     *
     * `call(await dep('X'), ...)` was the only correct form, and
     * `call('X', ...)` — which is what everyone writes first — produced
     * `RECIPIENT_NOT_FOUND: Recipient X is not registered`. That message reads
     * like the object is missing rather than like the argument is the wrong
     * kind of thing, so the recovery it invites is a hunt for the object's
     * "real" name. Accepting both forms removes the trap; naming what is
     * actually registered removes the hunt when a name is genuinely wrong.
     */
    const resolveTarget = async (to: unknown): Promise<AbjectId> => {
      const wasPending = typeof (to as { then?: unknown } | null)?.then === 'function';
      const raw = await to;
      if (typeof raw !== 'string' || raw.length === 0) {
        // A recipient that arrived as a Promise is almost always an
        // un-awaited `find`/`dep`. Saying only "needs a recipient" sends the
        // author looking for a wrong name, when the name was fine and the
        // `await` was missing — and the same omission makes `if (!found)`
        // test a Promise, which is always truthy, so the guard above this
        // line silently did nothing too.
        throw new Error(wasPending
          ? 'call() was given a pending Promise as the recipient, which resolved to nothing. `find()` and `dep()` are async — write `const obj = await find(name)`. Without the await, `if (!obj)` is also always false, so a missing-object check above this call did not fire.'
          : 'call() needs a recipient: an object id, or the name of a registered object');
      }
      if (UUID_RE.test(raw)) return raw as AbjectId;

      const cached = resolvedNames.get(raw);
      if (cached) return cached;

      // Single-shot first: the common case is a name that is registered right
      // now, and a hard requireDep would spend its whole retry window on a typo.
      let id = await this.discoverDep(raw);
      if (!id) {
        // One short retry covers the real race — an object registering moments
        // after the job started — without turning a typo into a long stall.
        await new Promise(r => setTimeout(r, 500));
        id = await this.discoverDep(raw);
      }
      if (!id) throw new Error(await this.unknownRecipientError(raw));

      resolvedNames.set(raw, id);
      return id;
    };

    /**
     * Whether this job works for a read-only check step: asked of AgentAbject
     * once, on the job's first call, and kept for the rest of the job.
     */
    let readOnlyTask: Promise<boolean> | undefined;
    const isReadOnlyTask = (): Promise<boolean> => {
      if (!job.taskId || job.runtimeStep) return Promise.resolve(false);
      return readOnlyTask ??= this.taskIsReadOnly(job.taskId);
    };

    /**
     * The LLM's id, for a private job only: its calls to the LLM are marked
     * private, so the ledger keeps no text of them.
     */
    let privateLlm: Promise<AbjectId | null> | undefined;
    const markedPrivate = async (resolved: AbjectId, payload: unknown): Promise<unknown> => {
      if (!job.private || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
      if (resolved !== await (privateLlm ??= this.discoverDep('LLM'))) return payload;
      return { ...(payload as Record<string, unknown>), private: true };
    };

    /** Send one call for the job; the helpers below decide whether it may go. */
    const sendCall = async (resolved: AbjectId, actualMethod: string, actualPayload: unknown) => {
      const msg = request(this.id, resolved as AbjectId, actualMethod, await markedPrivate(resolved, actualPayload));
      this.invocationContexts.set(msg.header.messageId, { callerId, taskId: job.taskId, target: resolved as AbjectId });
      running.awaiting.set(resolved, (running.awaiting.get(resolved) ?? 0) + 1);
      try {
        return await this.request<unknown>(msg, JOB_WAIT_MS);
      } finally {
        this.invocationContexts.delete(msg.header.messageId);
        const left = (running.awaiting.get(resolved) ?? 1) - 1;
        if (left > 0) running.awaiting.set(resolved, left); else running.awaiting.delete(resolved);
      }
    };

    const callFn = async (
      to: AbjectId | string | Promise<AbjectId>,
      method: string,
      payload: unknown = {},
      _unused?: unknown,
    ) => {
      // Backward compat: if called with 4 args and the 2nd looks like an interface ID, skip it
      let actualMethod = method;
      let actualPayload = payload;
      if (_unused !== undefined && typeof method === 'string' && typeof payload === 'string') {
        actualMethod = payload as unknown as string;
        actualPayload = _unused;
      }
      const resolved = await resolveTarget(to);
      // A check step's job reads only: a call that would change something is
      // refused before it is sent, with the reason.
      const args = actualPayload && typeof actualPayload === 'object' ? actualPayload as Record<string, unknown> : undefined;
      if (!isReadOperation(actualMethod, args) && await isReadOnlyTask()) {
        throw new Error(
          `This job belongs to a read-only check step, so it makes only calls that read; '${actualMethod}' would change something and was not sent. ` +
          'Read what the check needs (read, list, get, find, search, describe and the like) and return what you found.');
      }
      return sendCall(resolved, actualMethod, actualPayload);
    };

    const progressFn = async (message?: string) => {
      running.touch();
      if (callerId) {
        this.send(
          event(this.id, callerId, 'progress',
            { message: message ?? 'working', taskId: userContext?.taskId })
        );
      }
    };

    const depFn = async (name: string) => this.requireDep(name);
    const findFn = async (name: string) => this.discoverDep(name);

    /**
     * Ask an object a question in its own words.
     *
     * `find` resolves a name that is already known; `ask` is how code learns
     * what it does not. Without an affordance of its own the ask protocol was
     * reachable only as `call(await find('Registry'), 'ask', {...})`, so job
     * code reached for the name lookup sitting in scope and treated a miss as
     * proof of absence — which it is not, since a name match cannot see a
     * capability an object gained after it registered.
     *
     * `target` is an AbjectId or a registered name; omit it to ask the
     * Registry, which answers "which object does X?" from its whole catalog
     * and is the preferred first move for any which-object question.
     */
    const askFn = async (targetOrQuestion: string, maybeQuestion?: string) => {
      const asRegistry = maybeQuestion === undefined;
      const question = asRegistry ? targetOrQuestion : maybeQuestion;
      const target = asRegistry
        ? await this.resolveRegistryId()
        : (targetOrQuestion.includes('-') ? targetOrQuestion as AbjectId : await this.discoverDep(targetOrQuestion));
      if (!target) throw new Error(`ask: no object found for '${asRegistry ? 'Registry' : targetOrQuestion}'`);
      // Asking yourself can only return your own manifest, or — while a task
      // is running, which is exactly when job code runs — the busy notice,
      // whose whole purpose is to keep a poll from timing out. An agent once
      // asked itself for its state, got "busy executing 1 skill task" back,
      // and reported that to the user as a finding about the subject it was
      // supposed to be investigating.
      if (callerId && target === callerId) {
        throw new Error('ask: that object is you. Asking yourself returns your own description, or the busy notice while you are working — neither is evidence. Answer from what you already know, or do the work and report what it returns.');
      }
      // A question to the Registry reads its catalog, so a check step may ask
      // it; a question to anything else can set work going and goes by callFn.
      if (asRegistry) return sendCall(target as AbjectId, 'ask', { question });
      return callFn(target as AbjectId, 'ask', { question });
    };

    /**
     * Typed judgments without prose: choice / noul (yes-no) / score answers
     * with probabilities, through the LLM's decision model (or a chat model
     * emulating one). An explicit call, so no decision-site policy applies.
     */
    const decideFn = async (state: unknown, questions: Record<string, unknown>) =>
      // A judgment changes nothing, so a check step's job may ask for one.
      sendCall(await resolveTarget('LLM'), 'decide', { state, questions });

    // The inactivity limit: restarted by every stretch of code that runs
    // (each answered call, each timer) and by progress, the job's own or a
    // callee's (onProgressBubble).
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalled!: (err: Error) => void;
    const stop = new Promise<never>((_, reject) => { stalled = reject; });
    stop.catch(() => { /* raced below */ });
    const touch = (): void => {
      if (!job.timeoutMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stalled(new Error(
        `Job stopped: no progress for ${Math.round(job.timeoutMs! / 1000)} s (its time limit). ` +
        'Call progress() during long work, or split it into separate jobs.')), job.timeoutMs);
    };
    const running: RunningJob = { awaiting: new Map(), touch };

    const sandbox = new Sandbox({
      filename: `${job.id}.js`,
      sliceMs: JOB_SLICE_MS,
      timers: true,
      failStuckCalls: true,
      asyncHelpers: { ask: askFn, decide: decideFn, call: callFn, dep: depFn, find: findFn, progress: progressFn },
      onSlice: touch,
    });
    this.running.set(job.id, running);
    try {
      // Caller-bound values are copied in; the helpers above cannot be shadowed
      // (RESERVED_CONTEXT_KEYS dropped those names at submit).
      const globals: Record<string, unknown> = { id: this.id };
      for (const [key, value] of Object.entries(userContext ?? {})) {
        if (/^[A-Za-z_$][\w$]*$/.test(key)) globals[key] = value;
        else log.warn(`${job.id}: context key "${key}" is not a name code can use; left out`);
      }
      sandbox.setGlobals(globals);
      const body = sandbox.compileBody(job.code);
      touch();
      return await Promise.race([sandbox.run(body), stop]);
    } catch (err) {
      if (err instanceof SandboxTimeLimitError) {
        throw new Error(
          `Job stopped: its code ran for more than ${JOB_SLICE_MS / 1000} s without pausing. ` +
          'Split long computations into pieces with `await new Promise(r => setTimeout(r, 0))` between them.');
      }
      throw err;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      this.running.delete(job.id);
      sandbox.dispose(`${job.id} finished`);
    }
  }

  /** Whether a caller may see a job: any job but a private one, which only its submitter, AgentAbject and GoalManager see. */
  private async seesJob(job: Job, callerId: AbjectId): Promise<boolean> {
    if (!job.private || job.callerId === callerId) return true;
    return this.isBuiltInCaller(callerId, PRIVATE_JOB_READERS);
  }

  /**
   * Whether an agent task is private, by AgentAbject's getTaskStatus. A task
   * keeps its privacy for life, so an answer is remembered. No AgentAbject
   * means no private task; an AgentAbject that does not answer leaves the
   * job private, since the rule only restricts.
   */
  private async taskIsPrivate(taskId: string): Promise<boolean> {
    const known = this.taskPrivacy.get(taskId);
    if (known !== undefined) return known;
    const agents = await this.discoverDep('AgentAbject');
    if (!agents) return false;
    try {
      const status = await this.request<{ private?: boolean } | null>(request(this.id, agents, 'getTaskStatus', { taskId }), 10_000);
      const isPrivate = status?.private === true;
      if (status) this.rememberTaskPrivacy(taskId, isPrivate);
      return isPrivate;
    } catch {
      return true;
    }
  }

  private rememberTaskPrivacy(taskId: string, isPrivate: boolean): void {
    this.taskPrivacy.set(taskId, isPrivate);
    while (this.taskPrivacy.size > 1000) this.taskPrivacy.delete(this.taskPrivacy.keys().next().value!);
  }

  /**
   * Drop the jobs of a private goal's tasks. A queued one is cancelled (its
   * submitter gets the cancellation); a running one is marked private, so it
   * is dropped once it ends and answers; a finished one goes now.
   */
  private forgetPrivateTasks(taskIds: Set<string>): number {
    let dropped = 0;
    for (const taskId of taskIds) this.rememberTaskPrivacy(taskId, true);
    for (const [jobId, job] of [...this.jobs]) {
      if (!job.taskId || !taskIds.has(job.taskId)) continue;
      job.private = true;
      dropped++;
      if (job.status === 'running') continue;
      if (job.status === 'queued') {
        const q = this.queues.get(job.queue);
        const idx = q ? q.queue.indexOf(jobId) : -1;
        if (q && idx >= 0) q.queue.splice(idx, 1);
        job.status = 'failed';
        job.error = 'Cancelled';
        job.completedAt = Date.now();
        this.changed('jobFailed', { jobId, description: PRIVATE_TEXT, queue: job.queue, error: 'Cancelled', private: true });
        const resolver = this.pendingResolvers.get(jobId);
        if (resolver) {
          // The delivered cancellation drops the job.
          this.pendingResolvers.delete(jobId);
          resolver(job);
          continue;
        }
      }
      this.jobs.delete(jobId);
    }
    return dropped;
  }

  /**
   * Whether an agent task is a read-only check step, by AgentAbject's
   * getTaskStatus. Anything that cannot be confirmed (no AgentAbject, an
   * unknown task, no answer) reads as not read-only: the rule restricts, and
   * PermissionBroker still guards what reaches the host.
   */
  private async taskIsReadOnly(taskId: string): Promise<boolean> {
    try {
      const agents = await this.discoverDep('AgentAbject');
      if (!agents) return false;
      const status = await this.request<{ readOnly?: boolean } | null>(request(this.id, agents, 'getTaskStatus', { taskId }), 10_000);
      return status?.readOnly === true;
    } catch {
      return false;
    }
  }

  /** Progress from an object a running job is waiting on keeps that job's limit from firing. */
  protected override onProgressBubble(msg: AbjectMessage): void {
    for (const running of this.running.values()) {
      if (running.awaiting.has(msg.routing.from)) running.touch();
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    contractRequire(this.jobCounter >= 0, 'jobCounter must be non-negative');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## JobManager Usage Guide

### Submit a job for execution

  const result = await call(await dep('JobManager'), 'submitJob', {
    description: 'Calculate stats', code: 'return 2 + 2;', queue: 'default', timeoutMs: 86400000
  });
  // result: { jobId, status: 'completed'|'failed'|'cancelled', result?, error? }

Jobs run in a sandbox. These helpers are available:
- \`call(target, method, payload)\` — invoke a method on another object. Returns the method's reply.
- \`dep(name)\` — resolve a dependency by name. Returns a Promise<AbjectId> (a string).
- \`find(query)\` — find objects in the registry. Returns a Promise<AbjectId | null>. A miss is not proof of absence; ask the Registry.
- \`decide(state, questions)\`: typed judgments with probabilities, no prose: \`{ q1: { type: 'choice', instructions, criteria: { key: 'meaning', ... } }, q2: { type: 'noul', instructions }, q3: { type: 'score', instructions, criteria: ['low', 'mid', 'high'] } }\`. Returns \`{ answers: { q1: { choice, confidence, probabilities }, q2: { noul }, q3: { score, confidence } }, emulated, calibrated }\`. Keep control flow in code; act on confident answers.
- \`ask(question)\` — ask the Registry "which object does X?" from its whole catalog. \`ask(target, question)\` asks one object (AbjectId or registered name) about itself. Returns its answer as text.
- \`id\` — this object's AbjectId
- \`progress(message)\` — report that the job is still working
- The standard JavaScript built-ins (Math, JSON, Date, BigInt, Intl, Map, Set, typed arrays, ...) and \`setTimeout\`, \`setInterval\`, \`clearTimeout\`, \`clearInterval\`

What goes into a helper and what comes back are copies: JSON values and Uint8Array. Node and browser APIs (require, fetch, process, Buffer) do not exist; reach what they would provide by message, through \`dep(name)\` or \`find(query)\`.

### Limits

- A stretch of code may run for 10 s without pausing; past that it is stopped. Split a long computation into pieces with \`await new Promise(r => setTimeout(r, 0))\` between them.
- A job waiting on something that can never arrive (no call outstanding, no timer set) fails at once.
- With \`timeoutMs\`, a job is stopped when it goes that long without progress: no call answered, no \`progress()\`. The most it can be is a day.
- A \`call\` waits up to a day for its answer, and progress from the object answering keeps it waiting.
- When a job ends, its timers end with it.

### Calling objects — the canonical pattern

\`dep(name)\` and \`find(query)\` return an AbjectId (a plain string). Every interaction happens through \`call(id, method, payload)\`; methods live on the receiver, not on a local proxy:

  // Always: await the id, then pass it to call() with the method name.
  const storageId = await dep('Storage');
  const existing = await call(storageId, 'get', { key: 'my-key' });
  await call(storageId, 'set', { key: 'my-key', value: { hits: 1 } });

  const chatId = await dep('Chat');
  await call(chatId, 'addNotification', { sender: 'Scheduler', message: 'hi' });

Every method has a payload object; pass the exact parameter names the target method declares (see its manifest via the ask protocol). The pattern is always: \`const id = await dep('Name'); await call(id, 'method', { ...params });\`

### Inspect jobs

  const jobs = await call(await dep('JobManager'), 'listJobs', {});
  // jobs: [{ jobId, description, status, queue, queuedAt, startedAt?, completedAt?, result?, error? }]

  const job = await call(await dep('JobManager'), 'getJob', { jobId: 'job-1' });

### Manage jobs

  await call(await dep('JobManager'), 'cancelJob', { jobId: 'job-1' });
  await call(await dep('JobManager'), 'clearHistory', {});

### List queues

  const queues = await call(await dep('JobManager'), 'listQueues', {});
  // queues: [{ name, pendingCount, runningJobId? }]

### IMPORTANT
- The interface ID is 'abjects:job-manager'.
- Jobs execute sequentially per queue. The default queue is 'default'.
- submitJob is synchronous from the caller's perspective — it waits for the job to finish.`;
  }
}

export const JOBMANAGER_ID = 'abjects:job-manager' as AbjectId;
