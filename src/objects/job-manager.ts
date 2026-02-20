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
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const JOBMANAGER_INTERFACE: InterfaceId = 'abjects:job-manager';

export interface Job {
  id: string;
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

export interface JobResult {
  jobId: string;
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export class JobManager extends Abject {
  private jobs: Map<string, Job> = new Map();
  private queue: string[] = [];
  private currentJobId?: string;
  private jobCounter = 0;
  private pendingResolvers: Map<string, (job: Job) => void> = new Map();
  private processing = false;
  private consoleId?: AbjectId;
  private _currentCallMsgId?: string;
  private _currentJobCallerId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'JobManager',
        description:
          'Universal headless job execution service. Any abject can submit code-execution jobs. Sequential FIFO queue with event broadcasting.',
        version: '1.0.0',
        interfaces: [
          {
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
            ],
          },
        ],
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
      await this.send(
        request(this.id, this.consoleId, 'abjects:console' as InterfaceId, level, { message, data })
      );
    } catch { /* logging should never break the caller */ }
  }

  private setupHandlers(): void {
    // Reset call-level timeout on callee progress AND forward upstream to job submitter
    this.on('progress', (msg: AbjectMessage) => {
      if (this._currentCallMsgId) {
        this.resetRequestTimeout(this._currentCallMsgId);
      }
      if (this._currentJobCallerId) {
        this.send(
          event(this.id, this._currentJobCallerId, JOBMANAGER_INTERFACE, 'progress',
            msg.payload ?? {})
        ).catch(() => {});
      }
    });

    this.on('submitJob', async (msg: AbjectMessage) => {
      const { description, code } = msg.payload as { description: string; code: string };
      requireNonEmpty(description, 'description');
      requireNonEmpty(code, 'code');

      const callerId = msg.routing.from;
      const jobId = `job-${++this.jobCounter}`;

      const job: Job = {
        id: jobId,
        description,
        code,
        callerId,
        status: 'queued',
        queuedAt: Date.now(),
      };

      this.jobs.set(jobId, job);
      this.queue.push(jobId);

      // Broadcast jobQueued to dependents (JobBrowser)
      await this.changed('jobQueued', { jobId, description, position: this.queue.length });

      // Create a Promise that resolves when the job finishes
      const jobDone = new Promise<Job>((resolve) => {
        this.pendingResolvers.set(jobId, resolve);
      });

      // Kick off queue processing (fire-and-forget)
      this.processQueue();

      // Send the reply when the job completes (non-blocking)
      jobDone.then(async (finished) => {
        try {
          await this.sendDeferredReply(msg, {
            jobId: finished.id,
            status: finished.status,
            result: finished.result,
            error: finished.error,
          } as JobResult);
        } catch { /* caller may be gone */ }
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

      // Remove from queue
      const idx = this.queue.indexOf(jobId);
      if (idx >= 0) this.queue.splice(idx, 1);

      job.status = 'failed';
      job.error = 'Cancelled';
      job.completedAt = Date.now();

      // Resolve pending promise
      const resolver = this.pendingResolvers.get(jobId);
      if (resolver) {
        this.pendingResolvers.delete(jobId);
        resolver(job);
      }

      await this.changed('jobFailed', { jobId, description: job.description, error: 'Cancelled' });
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
      await this.changed('historyCleared', {});
      return true;
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;

      job.status = 'running';
      job.startedAt = Date.now();
      this.currentJobId = jobId;

      await this.changed('jobStarted', { jobId, description: job.description });
      await this.log('info', `Job started: ${job.description}`, { jobId });

      try {
        const result = await this.executeCode(job.code, job.callerId);
        job.status = 'completed';
        job.result = result;
        await this.changed('jobCompleted', { jobId, description: job.description, result });
        await this.log('info', `Job completed: ${job.description}`, { jobId, result });
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        await this.changed('jobFailed', { jobId, description: job.description, error: job.error });
        await this.log('error', `Job failed: ${job.description}`, { jobId, error: job.error });
      }

      job.completedAt = Date.now();
      this.currentJobId = undefined;

      // Resolve pending promise for this job
      const resolver = this.pendingResolvers.get(jobId);
      if (resolver) {
        this.pendingResolvers.delete(jobId);
        resolver(job);
      }
    }

    this.processing = false;
  }

  private async executeCode(code: string, callerId?: AbjectId): Promise<unknown> {
    this._currentJobCallerId = callerId;
    console.log(`[JobManager] Executing job code:\n${code}`);

    const callFn = async (
      to: AbjectId | string | Promise<AbjectId>,
      iface: string,
      method: string,
      payload: unknown = {},
    ) => {
      const resolved = await to;
      const msg = request(this.id, resolved as AbjectId, iface as InterfaceId, method, payload);
      this._currentCallMsgId = msg.header.messageId;
      try {
        return await this.request<unknown>(msg, 120000);
      } finally {
        this._currentCallMsgId = undefined;
      }
    };

    const progressFn = async (message?: string) => {
      if (this._currentJobCallerId) {
        await this.send(
          event(this.id, this._currentJobCallerId, JOBMANAGER_INTERFACE, 'progress',
            { message: message ?? 'working' })
        ).catch(() => {});
      }
    };

    const depFn = async (name: string) => this.requireDep(name);
    const findFn = async (name: string) => this.discoverDep(name);

    const fn = new Function(
      'call', 'dep', 'find', 'id', 'progress',
      `return (async () => { ${code} })()`,
    );

    try {
      return await fn(callFn, depFn, findFn, this.id, progressFn);
    } finally {
      this._currentJobCallerId = undefined;
      this._currentCallMsgId = undefined;
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    contractRequire(this.jobCounter >= 0, 'jobCounter must be non-negative');
  }
}

export const JOBMANAGER_ID = 'abjects:job-manager' as AbjectId;
