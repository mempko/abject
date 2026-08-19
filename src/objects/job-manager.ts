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
import { validateCode, runSandboxed, SANDBOX_BUILTIN_NAMES } from '../core/sandbox.js';
import { Log } from '../core/timed-log.js';
import { levenshtein } from './source-diff.js';

const log = new Log('JobManager');

/** An id is a UUID; anything else a job passes as a recipient is a name. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JOBMANAGER_INTERFACE: InterfaceId = 'abjects:job-manager';

// Sandbox builtins, blocked patterns, and execution are provided by core/sandbox.ts.
// JobManager only supplies its own application-level context (call, dep, find, progress).

export interface Job {
  id: string;
  queue: string;
  description: string;
  code: string;
  callerId: AbjectId;
  /**
   * Message id of the submitJob request. Carried into the direct jobFailed
   * caller notification so the caller can reject exactly the pending
   * request this job answers, instead of every pending JobManager request.
   */
  requestMessageId?: string;
  /** Extra values bound into the sandbox context alongside call/dep/find. */
  context?: Record<string, unknown>;
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
  currentCallMsgId?: string;
  currentJobCallerId?: AbjectId;
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
  'call', 'dep', 'find', 'id', 'progress', 'console',
]);

export class JobManager extends Abject {
  private jobs: Map<string, Job> = new Map();
  private queues: Map<string, QueueState> = new Map();
  private static readonly DEFAULT_QUEUE = 'default';
  private jobCounter = 0;
  private pendingResolvers: Map<string, (job: Job) => void> = new Map();
  private consoleId?: AbjectId;

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
                ],
                returns: { kind: 'reference', reference: 'JobResult' },
              },
              {
                name: 'listJobs',
                description: 'Return all jobs, most recent first.',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'Job' } },
              },
              {
                name: 'getJob',
                description: 'Return a single job by ID.',
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
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
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
    // NOTE: no custom 'progress' handler here. A previous version registered
    // one to forward heartbeats to job submitters, but Abject.init() registers
    // the base 'progress' handler AFTER the constructor runs setupHandlers(),
    // and on() is last-write-wins — so it was silently dead code. The base
    // handler now covers both needs: it resets our outbound call timers and
    // bubbles progress to every requester still waiting on a deferred reply
    // (which is exactly the submitJob callers tracked per queue).

    this.on('submitJob', async (msg: AbjectMessage) => {
      const { description, code, queue: queueName, context: userContext } = msg.payload as {
        description: string; code: string; queue?: string;
        context?: Record<string, unknown>;
      };
      requireNonEmpty(description, 'description');
      requireNonEmpty(code, 'code');

      // Defence-in-depth: reject code that tries to use raw Node.js APIs.
      const validation = validateCode(code);
      if (!validation.valid) {
        log.info(`BLOCKED job from ${msg.routing.from}: code contains '${validation.blocked}'`);
        throw new Error(
          `Job code rejected: '${validation.blocked}' is not allowed. ` +
          `Use call(), dep(), and find() to discover and invoke system capabilities.`,
        );
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
      const resolvedQueue = queueName ?? JobManager.DEFAULT_QUEUE;

      const job: Job = {
        id: jobId,
        queue: resolvedQueue,
        description,
        code,
        callerId,
        requestMessageId: msg.header.messageId,
        context: sanitisedContext,
        status: 'queued',
        queuedAt: Date.now(),
      };

      this.jobs.set(jobId, job);
      const q = this.getOrCreateQueue(resolvedQueue);
      q.queue.push(jobId);

      // Broadcast jobQueued to dependents (JobBrowser)
      this.changed('jobQueued', { jobId, description, queue: resolvedQueue, position: q.queue.length });

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
      });

      // Return DEFERRED_REPLY to suppress auto-reply and free the processing loop
      return DEFERRED_REPLY;
    });

    this.on('listJobs', async () => {
      const allJobs = Array.from(this.jobs.values());
      allJobs.sort((a, b) => b.queuedAt - a.queuedAt);
      return allJobs;
    });

    this.on('getJob', async (msg: AbjectMessage) => {
      const { jobId } = msg.payload as { jobId: string };
      return this.jobs.get(jobId) ?? null;
    });

    this.on('cancelJob', async (msg: AbjectMessage) => {
      const { jobId } = msg.payload as { jobId: string };
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'queued') return false;
      this.log('info', `cancelJob ${jobId} (${job.description})`);

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

      this.changed('jobFailed', { jobId, description: job.description, queue: job.queue, error: 'Cancelled' });
      return true;
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

        this.changed('jobStarted', { jobId, description: job.description, queue: job.queue });
        await this.log('info', `Job started: ${job.description}`, { jobId, queue: job.queue });

        try {
          const result = await this.executeCode(job.code, job.callerId, q, job.context);
          job.status = 'completed';
          job.result = result;
          this.changed('jobCompleted', { jobId, description: job.description, queue: job.queue, result });
          await this.log('info', `Job completed: ${job.description}`, { jobId, queue: job.queue, result });
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          this.changed('jobFailed', { jobId, description: job.description, queue: job.queue, error: job.error, requestMessageId: job.requestMessageId });
          await this.log('error', `Job failed: ${job.description}`, { jobId, queue: job.queue, error: job.error });

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

  private async executeCode(
    code: string,
    callerId: AbjectId | undefined,
    q: QueueState,
    userContext?: Record<string, unknown>,
  ): Promise<unknown> {
    q.currentJobCallerId = callerId;
    log.info(`Executing job code (queue: ${q.name}):\n${code}`);

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
      const raw = await to;
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('call() needs a recipient: an object id, or the name of a registered object');
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
      const msg = request(this.id, resolved as AbjectId, actualMethod, actualPayload);
      q.currentCallMsgId = msg.header.messageId;
      try {
        return await this.request<unknown>(msg, 600000);
      } finally {
        q.currentCallMsgId = undefined;
      }
    };

    const progressFn = async (message?: string) => {
      if (q.currentJobCallerId) {
        this.send(
          event(this.id, q.currentJobCallerId, 'progress',
            { message: message ?? 'working' })
        );
      }
    };

    const depFn = async (name: string) => this.requireDep(name);
    const findFn = async (name: string) => this.discoverDep(name);

    // Caller-bound values first; built-ins second so they cannot be shadowed.
    const context: Record<string, unknown> = {
      ...(userContext ?? {}),
      call: callFn,
      dep: depFn,
      find: findFn,
      id: this.id,
      progress: progressFn,
    };

    try {
      return await runSandboxed(code, context, {
        filename: `job-${this.jobCounter}.js`,
      });
    } finally {
      q.currentJobCallerId = undefined;
      q.currentCallMsgId = undefined;
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
    description: 'Calculate stats', code: 'return 2 + 2;', queue: 'default'
  });
  // result: { jobId, status: 'completed'|'failed'|'cancelled', result?, error? }

Jobs run in a sandboxed environment. Only these helpers and built-ins are available:
- \`call(target, method, payload)\` — invoke a method on another object. Returns the method's reply.
- \`dep(name)\` — resolve a dependency by name. Returns a Promise<AbjectId> (a string).
- \`find(query)\` — find objects in the registry. Returns a Promise<AbjectId | undefined>.
- \`id\` — this object's AbjectId
- \`progress(pct)\` — report progress (0-100)
- Built-ins: ${SANDBOX_BUILTIN_NAMES.join(', ')}

No other globals exist. require, fetch, process, Buffer, setTimeout, and all Node.js/browser APIs are unavailable. Use \`dep(name)\` or \`find(query)\` to discover available system capabilities at runtime.

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
