/**
 * SandboxInvoker -- runs a ScriptableAbject handler-map source with every
 * inter-object call shimmed. HTTP is served from the fitness gate's HttpStub;
 * anything else an object tries to reach throws, so a candidate cannot pass
 * judgment by phoning the real world.
 *
 * Each invocation runs on a dedicated WORKER THREAD, inside a vm context that
 * exposes only the sandbox builtins. The worker is what makes the timeout
 * real: `worker.terminate()` preempts anything -- a synchronous spin, a spin
 * after an await, even `Atomics.wait` -- where a vm-level timeout only covers
 * the evaluation it was passed to, and an in-process microtask-mode drain
 * corrupts async_hooks (observed as a native "async hook stack has become
 * corrupted" crash under the test runner; any AsyncLocalStorage user is
 * exposed the same way). `resourceLimits` bounds the candidate's heap, so an
 * allocation bomb kills the worker, not the judge. Timers work normally --
 * the worker has its own event loop -- so a legitimate retry-with-backoff
 * candidate is judged, not killed.
 *
 * The stub crosses the thread boundary synchronously: the worker posts the
 * request and blocks on Atomics.wait while the host answers on its own event
 * loop. Everything that crosses is structured-clone data; no host closure is
 * reachable from the candidate.
 *
 * Residual risk, stated plainly: `vm` inside the worker is API hygiene, not a
 * security boundary (Node's own docs). An escape lands in the worker -- which
 * holds no secrets and dies with the invocation chain -- rather than in the
 * judge's process. That containment is the reason judging pays a worker
 * round-trip instead of running in-process.
 */
import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import { validateCode } from '../core/sandbox.js';
import type { Invoker, HttpStub } from './fitness.js';

/** Wall-clock ceiling on ONE judged invocation, compile included. On expiry
 *  the worker is terminated -- preempting even blocked threads -- and the
 *  invocation fails. A timing-out mutant is thereby killed; a timing-out
 *  candidate fails. */
export const FITNESS_INVOCATION_TIMEOUT_MS = 5000;

/** Candidate heap ceiling. Generous for handler logic; an allocation bomb
 *  (one `new Array(1e9)` needs no loop to OOM) kills the worker instead of
 *  the process that judges. */
const WORKER_MAX_OLD_SPACE_MB = 256;

/** The worker body, evaluated as CommonJS via `new Worker(code, {eval:true})`
 *  so it needs no loader. It executes one job at a time: build a vm context,
 *  compile the handler map, bind it to a runtime-shaped proxy, invoke, and
 *  post the outcome back. The `call` shim answers from the host's stub via
 *  the synchronous Atomics channel. */
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { receiveMessageOnPort } = require('node:worker_threads');
const vm = require('node:vm');

const signal = new Int32Array(workerData.signal);
const stubPort = workerData.stubPort;

// Mirrors SANDBOX_BUILTINS in ../core/sandbox.js, rebuilt from this worker's
// realm (live host functions cannot cross the thread boundary).
const BUILTINS = {
  Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp,
  Map, Set, Promise, Error, TypeError, RangeError,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  setTimeout, setInterval, clearTimeout, clearInterval,
  console: { log() {}, warn() {}, error() {} },
};

// Ask the host's HttpStub, synchronously: post the request, sleep on the
// signal until the host has written the reply to the port.
function askStub(req) {
  Atomics.store(signal, 0, 0);
  stubPort.postMessage(req);
  Atomics.wait(signal, 0, 0);
  const m = receiveMessageOnPort(stubPort);
  return m ? m.message : undefined;
}

function harness(source) {
  return \`
    const call = async (target, method, payload) => {
      if (target !== 'HttpClient') {
        throw new Error("fitness: unstubbed I/O -- call('" + target + "', '" + method + "')");
      }
      const url = String((payload && payload.url) ?? '');
      const httpMethod = method === 'post' || method === 'postJson' ? 'POST'
        : String((payload && payload.method) ?? 'GET').toUpperCase();
      const hit = __http({ method: httpMethod, url, body: payload && payload.body });
      if (!hit) throw new Error('fitness: unstubbed I/O -- no cassette for ' + httpMethod + ' ' + url);
      // The exact shape HttpClient's ask guide teaches objects: body is
      // ALWAYS a raw string, ok is 2xx.
      return { status: hit.status, statusText: '', headers: {}, body: hit.rawBody,
               ok: hit.status >= 200 && hit.status < 300 };
    };
    const dep = (name) => name;
    const find = () => { throw new Error('fitness: unstubbed I/O -- find()'); };
    // A minimal stand-in for ScriptableAbject's handler proxy. Handlers are
    // bound to it so \\\`this.sibling(...)\\\` resolves the way it does in the
    // live runtime. State-mutating members are inert: judgment must not
    // persist anything.
    const proxy = {
      call, dep, find,
      data: {},
      saveData: async () => {},
      emit: () => {}, changed: () => {}, observe: () => {},
      ensure: (cond, message) => {
        if (!cond) throw new Error('ContractViolation (ensure): ' + (message ?? 'condition failed'));
      },
      invariant: (cond, message) => {
        if (!cond) throw new Error('ContractViolation (invariant): ' + (message ?? 'invariant failed'));
      },
      id: 'fitness-candidate',
    };
    // Members the proxy owns; user members never shadow them. Mirrors
    // ScriptableAbject.PROXY_BUILTINS.
    const PROXY_BUILTINS = new Set(['call', 'dep', 'find', 'changed', 'emit', 'observe', 'id',
      'data', 'saveData', 'ensure', 'invariant']);
    const handlers = (\${source});
    const bound = new Map();
    for (const [key, value] of Object.entries(handlers ?? {})) {
      if (typeof value === 'function') {
        const fn = value.bind(proxy);
        bound.set(key, fn);
        if (!PROXY_BUILTINS.has(key)) proxy[key] = fn;
      } else if (!PROXY_BUILTINS.has(key)) {
        proxy[key] = value; // state property, same as the runtime does
      }
    }
    const handler = bound.get(__method) ?? bound.get('*');
    if (!handler) throw new Error("fitness: source has no handler for '" + __method + "'");
    return handler({ payload: __args });
  \`;
}

parentPort.on('message', async (job) => {
  try {
    const ctx = vm.createContext({
      ...BUILTINS,
      __http: askStub,
      __method: job.method,
      __args: job.args,
    });
    const script = new vm.Script('(async () => {' + harness(job.source) + '})()',
      { filename: 'fitness-invoker.js' });
    const value = await script.runInContext(ctx);
    // Outcomes must survive structured clone; a candidate returning a
    // function or symbol is returning something no manifest can declare.
    parentPort.postMessage({ id: job.id, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false,
      error: String((err && err.message) || err) });
  }
});
`;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  http: HttpStub;
  timer: ReturnType<typeof setTimeout>;
}

/** One worker, reused across the sequential invocations of an evaluate()
 *  run; respawned lazily after a termination. */
class WorkerInvoker {
  private worker: Worker | undefined;
  private signal: Int32Array | undefined;
  private stubPort: MessagePort | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private timeoutMs: number) {}

  private spawn(): void {
    const sab = new SharedArrayBuffer(4);
    this.signal = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    this.stubPort = port1;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { signal: sab, stubPort: port2 },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_SPACE_MB },
    });
    this.worker.unref();
    port1.on('message', (req: { method: string; url: string; body?: unknown }) => {
      // Exactly one invocation is in flight per worker, so the sole pending
      // entry owns every stub request.
      const inflight = [...this.pending.values()][0];
      let hit: unknown;
      try { hit = inflight?.http(req) ?? null; } catch { hit = null; }
      port1.postMessage(hit);
      Atomics.store(this.signal!, 0, 1);
      Atomics.notify(this.signal!, 0);
    });
    // Attaching the listener re-refs the port; without this, an idle judged
    // process never exits.
    port1.unref();
    this.worker.on('message', (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    });
    this.worker.on('error', (err: Error) => this.failAll(new Error(`fitness: worker error -- ${err.message}`)));
    this.worker.on('exit', (code) => {
      // An OOM-killed or crashed worker exits without answering; terminate()
      // after a timeout lands here too, but its pending entry is already
      // rejected and cleared.
      if (code !== 0) this.failAll(new Error('fitness: worker died while judging (resource limit or crash)'));
      this.worker = undefined;
    });
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  invoke(source: string, method: string, args: Record<string, unknown>, http: HttpStub): Promise<unknown> {
    const check = validateCode(source);
    if (!check.valid) {
      return Promise.reject(new Error(`fitness: blocked construct -- ${check.blocked}`));
    }
    if (!this.worker) this.spawn();
    const worker = this.worker!;
    worker.ref();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.worker = undefined; // respawn on next invocation
        void worker.terminate();
        reject(new Error('fitness: invocation timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, http, timer });
      worker.postMessage({ id, source, method, args });
    }).finally(() => { if (this.worker === worker && this.pending.size === 0) worker.unref(); });
  }
}

export function buildSandboxInvoker(opts?: { timeoutMs?: number }): Invoker {
  const invoker = new WorkerInvoker(opts?.timeoutMs ?? FITNESS_INVOCATION_TIMEOUT_MS);
  return (source, method, args, http) => invoker.invoke(source, method, args, http);
}
