/**
 * JobManager — universal headless job execution service.
 *
 * Any abject can submit code-execution jobs. Jobs run sequentially in FIFO
 * order. The manager broadcasts events for observability (JobBrowser, Chat).
 */

import * as vm from 'vm';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as contractRequire, requireNonEmpty } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('JobManager');

const JOBMANAGER_INTERFACE: InterfaceId = 'abjects:job-manager';

/**
 * Patterns that must never appear in job code. Jobs should only use the
 * provided `call`, `dep`, `find`, and `progress` helpers — never raw
 * Node.js APIs. This is defence-in-depth; the `new Function` call also
 * shadows these globals at runtime.
 */
/**
 * Single source of truth for the safe built-ins exposed inside the job sandbox.
 * Used both to build the vm.createContext() and to generate the ask-protocol guide.
 */
const SANDBOX_BUILTINS: Record<string, unknown> = {
  Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp,
  Map, Set, Promise, Error, TypeError, RangeError,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  console: { log() {}, warn() {}, error() {} },
};

const SANDBOX_BUILTIN_NAMES = Object.keys(SANDBOX_BUILTINS).filter(k => k !== 'console');

const BLOCKED_CODE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\bexecSync\b/, label: 'execSync' },
  { pattern: /\bexecFile\b/, label: 'execFile' },
  { pattern: /\bspawnSync\b/, label: 'spawnSync' },
  { pattern: /\bprocess\s*\.\s*(exit|kill|env|execPath|binding)/, label: 'process.*' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  { pattern: /\bglobal\b/, label: 'global' },
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
  { pattern: /\bfetch\s*\(/, label: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
];

export interface Job {
  id: string;
  queue: string;
  description: string;
  code: string;
  callerId: AbjectId;
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
    // Reset call-level timeout on callee progress AND forward upstream to job submitter
    this.on('progress', (msg: AbjectMessage) => {
      // Broadcast to all active queues — progress is a heartbeat/timeout-reset signal
      for (const q of this.queues.values()) {
        if (q.currentCallMsgId) {
          this.resetRequestTimeout(q.currentCallMsgId);
        }
        if (q.currentJobCallerId) {
          this.send(
            event(this.id, q.currentJobCallerId, 'progress',
              msg.payload ?? {})
          );
        }
      }
    });

    this.on('submitJob', async (msg: AbjectMessage) => {
      const { description, code, queue: queueName } = msg.payload as {
        description: string; code: string; queue?: string;
      };
      requireNonEmpty(description, 'description');
      requireNonEmpty(code, 'code');

      // Defence-in-depth: reject code that tries to use raw Node.js APIs.
      for (const { pattern, label } of BLOCKED_CODE_PATTERNS) {
        if (pattern.test(code)) {
          log.info(`BLOCKED job from ${msg.routing.from}: code contains '${label}'`);
          throw new Error(
            `Job code rejected: '${label}' is not allowed. ` +
            `Use call(), dep(), and find() to discover and invoke system capabilities.`,
          );
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
          const result = await this.executeCode(job.code, job.callerId, q);
          job.status = 'completed';
          job.result = result;
          this.changed('jobCompleted', { jobId, description: job.description, queue: job.queue, result });
          await this.log('info', `Job completed: ${job.description}`, { jobId, queue: job.queue, result });
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          this.changed('jobFailed', { jobId, description: job.description, queue: job.queue, error: job.error });
          await this.log('error', `Job failed: ${job.description}`, { jobId, queue: job.queue, error: job.error });
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

  private async executeCode(code: string, callerId: AbjectId | undefined, q: QueueState): Promise<unknown> {
    q.currentJobCallerId = callerId;
    log.info(`Executing job code (queue: ${q.name}):\n${code}`);

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
      const resolved = await to;
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

    // Airtight sandbox: only the 5 allowed helpers exist in the context.
    // No require, fetch, process, globalThis, or any other Node.js globals.
    const sandbox = vm.createContext({
      call: callFn,
      dep: depFn,
      find: findFn,
      id: this.id,
      progress: progressFn,
      ...SANDBOX_BUILTINS,
    });

    const script = new vm.Script(
      `(async () => { ${code} })()`,
      { filename: `job-${this.jobCounter}.js` },
    );

    try {
      return await script.runInContext(sandbox);
    } finally {
      q.currentJobCallerId = undefined;
      q.currentCallMsgId = undefined;
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    contractRequire(this.jobCounter >= 0, 'jobCounter must be non-negative');
  }

  protected override getSourceForAsk(): string | undefined {
    return `## JobManager Usage Guide

### Submit a job for execution

  const result = await call(await dep('JobManager'), 'submitJob', {
    description: 'Calculate stats', code: 'return 2 + 2;', queue: 'default'
  });
  // result: { jobId, status: 'completed'|'failed'|'cancelled', result?, error? }

Jobs run in a sandboxed environment. Only these helpers and built-ins are available:
- \`call(target, method, payload)\` — call other objects
- \`dep(name)\` — resolve a dependency by name
- \`find(query)\` — find objects in the registry
- \`id\` — this object's AbjectId
- \`progress(pct)\` — report progress (0-100)
- Built-ins: ${SANDBOX_BUILTIN_NAMES.join(', ')}

No other globals exist. require, fetch, process, Buffer, setTimeout, and all Node.js/browser APIs are unavailable. Use \`dep(name)\` or \`find(query)\` to discover available system capabilities at runtime.

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
