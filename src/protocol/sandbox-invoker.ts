/**
 * SandboxInvoker -- runs one handler of a ScriptableAbject handler-map source
 * with every outbound `call()` answered by the judge's stub. Nothing the
 * candidate does reaches another object: a call the recording never saw
 * throws, so a candidate cannot pass judgment by phoning the real world.
 *
 * Each invocation runs on a dedicated WORKER THREAD, inside a DONT_CONTEXTIFY
 * vm context matching the live Sandbox (core/sandbox.ts). The worker is what
 * makes the wall-clock deadline and heap bound real: `worker.terminate()`
 * preempts anything -- a synchronous spin, a spin after an await, a timer loop,
 * even `Atomics.wait` -- and `resourceLimits` bounds the candidate's heap, so
 * an allocation bomb kills the worker, not the judge. Timers work normally --
 * the worker has its own event loop -- so a retry-with-backoff candidate is
 * judged, not killed.
 *
 * Fidelity: the context is built with `vm.constants.DONT_CONTEXTIFY` and the
 * same removed-globals and `this`-proxy member lists as core/sandbox.ts
 * (`SANDBOX_REMOVED_GLOBALS`, `HANDLER_PROXY_BUILTINS`). The proxy member
 * BODIES below are the harness's own stand-ins (`call` answers from the
 * recording, `data` is empty, state-mutating members are inert), so a
 * handler whose result depends on `this.data` is not reproduced here and is
 * excluded by the control run rather than judged.
 *
 * The stub crosses the thread boundary synchronously: the worker posts the
 * request and blocks on Atomics.wait while the host answers on its own event
 * loop. Everything that crosses is structured-clone data; no host closure is
 * reachable from the candidate.
 *
 * What the worker gives the judge: a hard deadline (`terminate()`), a heap
 * cap, an empty `process.env` (`env: {}`), its own stdio, and a message-only
 * interface. It is not a confidentiality boundary: Node's docs say `vm` is
 * not a security mechanism, and that holds inside a worker too.
 */
import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import { Sandbox, SANDBOX_REMOVED_GLOBALS, HANDLER_PROXY_BUILTINS } from '../core/sandbox.js';
import type { Invoker, CallStub, CallStubRequest } from './fitness.js';

/** Wall-clock ceiling on ONE judged invocation, compile included. On expiry
 *  the worker is terminated -- preempting even blocked threads -- and the
 *  invocation fails: a timing-out candidate contradicts its recording. */
export const FITNESS_INVOCATION_TIMEOUT_MS = 5000;

/** Candidate heap ceiling. Generous for handler logic; an allocation bomb
 *  (one `new Array(1e9)` needs no loop to OOM) kills the worker instead of
 *  the process that judges. */
const WORKER_MAX_OLD_SPACE_MB = 256;

/** The worker body, evaluated as CommonJS via `new Worker(code, {eval:true})`
 *  so it needs no loader. One job at a time: build a DONT_CONTEXTIFY vm
 *  context matching the runtime Sandbox, compile the handler map, bind it to
 *  a runtime-shaped proxy, invoke, post the outcome back. */
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData, receiveMessageOnPort } = require('node:worker_threads');
const vm = require('node:vm');

const signal = new Int32Array(workerData.signal);
const stubPort = workerData.stubPort;

// A judged handler can leave work running after it returns (an un-awaited
// call, a timer's async callback). One worker runs a judgment's jobs in
// turn, so such work outlives its job, and its rejection must not take the
// worker, and the next job with it, down. The job already has its outcome.
process.on('unhandledRejection', () => {});
const REMOVED_GLOBALS = workerData.removedGlobals;
const PROXY_BUILTINS = workerData.proxyBuiltins;

// Ask the host's stub, synchronously: post the request, sleep on the
// signal until the host has written the reply to the port.
function askStubText(target, method, payloadText) {
  Atomics.store(signal, 0, 0);
  stubPort.postMessage({ target: String(target), method: String(method), payloadText: String(payloadText) });
  Atomics.wait(signal, 0, 0);
  const m = receiveMessageOnPort(stubPort);
  return m && m.message ? JSON.stringify(m.message) : '';
}

const BOOTSTRAP_SCRIPT = new vm.Script(\`(function(__stubText, __timerSet, __timerClear, __removed, __proxyBuiltins) {
  'use strict';
  const G = globalThis;
  const JSONParse = JSON.parse;
  const JSONStringify = JSON.stringify;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  for (let i = 0; i < __removed.length; i++) delete G[__removed[i]];
  try { Object.defineProperty(ErrorCtor, 'prepareStackTrace', { value: undefined, writable: false, enumerable: false, configurable: false }); } catch {}
  const proxyBuiltins = new Set(__proxyBuiltins);

  // Every outbound call is answered from the recording or refused. No
  // object is special here: HttpClient, Storage, a sibling user object --
  // the recording either has the answer or the candidate is asking the
  // world something the live object never asked.
  const call = async (target, method, payload, options) => {
    // The same two shapes the live proxy takes: (to, method, payload?, options?)
    // and the older (to, interfaceId, method, payload), and the same {} for a
    // missing or null payload, so the stub is asked what the live object asked.
    if (options !== undefined && typeof method === 'string' && typeof payload === 'string') {
      method = payload;
      payload = options;
    }
    // The live proxy awaits its target, and the prompt teaches
    // this.call(this.dep('X'), ...) where dep() returns a promise, so the
    // harness must await it too or every such call stubs as [object Promise].
    const t = await target;
    let raw;
    try { raw = __stubText(String(t), String(method), JSONStringify(payload == null ? {} : payload)); }
    catch { throw new ErrorCtor('fitness: stub call failed'); }
    if (!raw) throw new ErrorCtor("fitness: unrecorded call -- call('" + t + "', '" + method + "')");
    const hit = JSONParse(raw);
    if (hit.errorText !== undefined) throw new ErrorCtor(hit.errorText);
    return JSONParse(hit.replyText);
  };
  // Names stand for themselves: the recording keys outbound calls by the
  // registered name, and dep()/find() at runtime resolve a name to an id
  // that would mean nothing here. An id the handler got from a stubbed
  // reply or its arguments is the recorded id, and the recording keeps
  // that id as the target, so it matches as it is.
  const dep = async (name) => name;
  const find = async (name) => name;
  // The stand-in for ScriptableAbject's handler proxy. Handlers are bound
  // to it so \\\`this.sibling(...)\\\` resolves the way it does live.
  // State-mutating members are inert: judgment must not persist anything.
  const proxy = {
    call, dep, find,
    data: {},
    saveData: async () => {},
    emit: async () => {}, changed: () => {}, observe: async () => {},
    ensure: (cond, message) => {
      if (!cond) throw new ErrorCtor('ContractViolation (ensure): ' + (message ?? 'condition failed'));
    },
    invariant: (cond, message) => {
      if (!cond) throw new ErrorCtor('ContractViolation (invariant): ' + (message ?? 'invariant failed'));
    },
    id: 'fitness-candidate',
  };
  for (const [k, v] of Object.entries(proxy)) G[k] = v;
  G.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  G.setTimeout = (fn, ms, ...a) => {
    if (typeof fn !== 'function') throw new TypeErrorCtor('A timer callback must be a function');
    return __timerSet(false, typeof ms === 'number' && ms > 0 ? ms : 0, () => fn(...a));
  };
  G.setInterval = (fn, ms, ...a) => {
    if (typeof fn !== 'function') throw new TypeErrorCtor('A timer callback must be a function');
    return __timerSet(true, typeof ms === 'number' && ms > 0 ? ms : 0, () => fn(...a));
  };
  G.clearTimeout = (id) => { if (typeof id === 'number') __timerClear(id); };
  G.clearInterval = (id) => { if (typeof id === 'number') __timerClear(id); };

  return function runCandidate(evalHandlers, __method, __argsText, __done) {
    (async () => {
      const handlers = evalHandlers();
      if (handlers === null || typeof handlers !== 'object') throw new ErrorCtor('fitness: source must evaluate to a handler map');
      const bound = new Map();
      for (const [key, value] of Object.entries(handlers)) {
        if (typeof value === 'function') {
          const fn = value.bind(proxy);
          bound.set(key, fn);
          if (!proxyBuiltins.has(key)) proxy[key] = fn;
        } else if (!proxyBuiltins.has(key)) {
          proxy[key] = value; // state property, same as the runtime does
        }
      }
      const handler = bound.get(__method) ?? bound.get('*');
      if (!handler) throw new ErrorCtor("fitness: source has no handler for '" + __method + "'");
      const value = await handler({ header: { messageId: 'fitness-replay', sequenceNumber: 0, timestamp: 0, type: 'request' },
        payload: JSONParse(__argsText), routing: { from: 'fitness-judge', to: 'fitness-candidate', method: __method } });
      // Outcomes must survive structured clone; a candidate returning a
      // function or symbol is returning something no message can carry.
      return JSONParse(JSONStringify(value === undefined ? null : value));
    })().then(
      (value) => __done(JSONStringify({ ok: true, value })),
      (err) => __done(JSONStringify({ ok: false, error: String((err && err.message) || err) }))
    );
  };
})\`, { filename: 'fitness-harness.js' });

parentPort.on('message', (job) => {
  let timerSeq = 0;
  const jobTimers = new Map();
  const clearAllTimers = () => {
    for (const handle of jobTimers.values()) { clearTimeout(handle); clearInterval(handle); }
    jobTimers.clear();
  };
  const timerSet = (repeat, ms, cb) => {
    const id = ++timerSeq;
    // A timer set by work that outlived its job would fire during the next
    // job on this worker. It is never armed.
    if (settled) return id;
    const handle = repeat
      ? setInterval(() => { try { cb(); } catch {} }, Math.max(10, ms))
      : setTimeout(() => { jobTimers.delete(id); try { cb(); } catch {} }, ms);
    jobTimers.set(id, handle);
    return id;
  };
  const timerClear = (id) => {
    const handle = jobTimers.get(id);
    if (handle !== undefined) { clearTimeout(handle); clearInterval(handle); jobTimers.delete(id); }
  };
  let settled = false;
  const finish = (msg) => {
    if (settled) return;
    settled = true;
    clearAllTimers();
    parentPort.postMessage(msg);
  };
  const stubTextForJob = (target, method, payloadText) => {
    if (settled) throw new Error('settled');
    return askStubText(target, method, payloadText);
  };
  try {
    const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
      codeGeneration: { strings: false, wasm: false },
    });
    const runCandidate = BOOTSTRAP_SCRIPT.runInContext(ctx)(
      stubTextForJob,
      timerSet,
      timerClear,
      REMOVED_GLOBALS,
      PROXY_BUILTINS,
    );
    const candidateScript = new vm.Script('() => (\\n' + job.source + '\\n)', {
      filename: 'abject-fitness-candidate.js',
    });
    const evalHandlers = candidateScript.runInContext(ctx);
    runCandidate(
      evalHandlers,
      job.method,
      JSON.stringify(job.args === undefined ? {} : job.args),
      (text) => {
        const res = JSON.parse(text);
        finish(res.ok ? { id: job.id, ok: true, value: res.value } : { id: job.id, ok: false, error: res.error });
      },
    );
  } catch (err) {
    finish({ id: job.id, ok: false, error: String((err && err.message) || err) });
  }
});
`;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  stub: CallStub;
  timer: ReturnType<typeof setTimeout>;
}

/** One spawned worker and everything scoped to it. The pending map and the
 *  event handlers belong to THIS worker: a stale worker's exit/error must
 *  never touch the entries of the replacement that took its place after a
 *  timeout, or it rejects a live job and leaks the new thread. */
interface WorkerConn {
  worker: Worker;
  signal: Int32Array;
  stubPort: MessagePort;
  pending: Map<number, Pending>;
  nextId: number;
  /** Cleared the instant this worker is abandoned (timeout/dispose/exit), so
   *  invoke() never hands a job to a worker that is on its way out. */
  alive: boolean;
}

/** One worker, reused across the sequential invocations of an evaluate()
 *  run; respawned lazily after a termination. */
class WorkerInvoker {
  private conn: WorkerConn | undefined;
  /** Set by dispose(): a disposed invoker refuses new jobs instead of
   *  respawning a worker for them. */
  private disposed = false;

  constructor(private timeoutMs: number) {}

  private spawn(): WorkerConn {
    const sab = new SharedArrayBuffer(4);
    const signal = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      // Empty environment and own stdio: the worker starts without a copy of
      // the host's environment variables. Hygiene, not isolation (see above).
      env: {},
      stdout: true,
      stderr: true,
      workerData: {
        signal: sab,
        stubPort: port2,
        removedGlobals: [...SANDBOX_REMOVED_GLOBALS],
        proxyBuiltins: [...HANDLER_PROXY_BUILTINS],
      },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_SPACE_MB },
    });
    worker.unref();
    const conn: WorkerConn = { worker, signal, stubPort: port1, pending: new Map(), nextId: 1, alive: true };
    port1.on('message', (req: CallStubRequest) => {
      // Exactly one invocation is in flight per worker, so the sole pending
      // entry owns every stub request.
      const inflight = [...conn.pending.values()][0];
      let hit: unknown;
      try { hit = inflight?.stub(req) ?? null; } catch { hit = null; }
      port1.postMessage(hit);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
    // Attaching the listener re-refs the port; without this, an idle judge
    // never lets the process exit.
    port1.unref();
    worker.on('message', (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    });
    worker.on('error', (err: Error) => this.failConn(conn, new Error(`fitness: worker error -- ${err.message}`)));
    worker.on('exit', (code) => {
      // An OOM-killed or crashed worker exits without answering; terminate()
      // after a timeout lands here too, but its pending entry is already
      // rejected and cleared. Only the handlers bound to THIS conn run, and
      // they touch only this conn's pending -- never the replacement's.
      if (code !== 0) this.failConn(conn, new Error('fitness: worker died while judging (resource limit or crash)'));
      conn.alive = false;
      if (this.conn === conn) this.conn = undefined;
    });
    return conn;
  }

  private failConn(conn: WorkerConn, err: Error): void {
    for (const [id, p] of conn.pending) {
      conn.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  invoke(source: string, method: string, args: Record<string, unknown>, stub: CallStub): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('fitness: invoker disposed'));
    try {
      Sandbox.checkSource(source, 'handlers');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return Promise.reject(new Error(`fitness: blocked construct -- ${reason}`));
    }
    if (!this.conn || !this.conn.alive) this.conn = this.spawn();
    const conn = this.conn;
    conn.worker.ref();
    const id = conn.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        conn.alive = false;                 // this worker is abandoned...
        if (this.conn === conn) this.conn = undefined; // ...and the next invoke respawns
        void conn.worker.terminate();
        reject(new Error('fitness: invocation timeout'));
      }, this.timeoutMs);
      conn.pending.set(id, { resolve, reject, stub, timer });
      conn.worker.postMessage({ id, source, method, args });
    }).finally(() => { if (this.conn === conn && conn.pending.size === 0) conn.worker.unref(); });
  }

  /** Release the worker. Idempotent; a later invoke respawns. */
  dispose(): void {
    this.disposed = true;
    const conn = this.conn;
    this.conn = undefined;
    if (conn) {
      conn.alive = false;
      this.failConn(conn, new Error('fitness: invoker disposed'));
      void conn.worker.terminate();
    }
  }
}

export interface SandboxInvoker extends Invoker {
  dispose(): void;
}

export function buildSandboxInvoker(opts?: { timeoutMs?: number }): SandboxInvoker {
  const invoker = new WorkerInvoker(opts?.timeoutMs ?? FITNESS_INVOCATION_TIMEOUT_MS);
  const fn = ((source, method, args, stub) => invoker.invoke(source, method, args, stub)) as SandboxInvoker;
  fn.dispose = () => invoker.dispose();
  return fn;
}
