/**
 * Sandbox: runs untrusted JavaScript (job code, generated and package
 * objects, trigger expressions) so that it reaches only what it is handed,
 * and only for as long as it is allowed.
 *
 * Two rules hold it together.
 *
 * Data, never objects, cross the boundary. The context is created with
 * DONT_CONTEXTIFY, so its global object and every built-in in it belong to the
 * sandbox. Any host object handed in (a helper function, a payload, an error,
 * a promise) would be a way back to the host's function constructor, and from
 * there to the whole process. So values cross as copies, encoded on one side
 * and decoded on the other with the same rules the wire codec uses between
 * workers (JSON, plus Uint8Array and the non-finite numbers), and the helpers
 * code calls are wrappers that live inside the sandbox and talk to the host
 * through one function that takes and returns strings and numbers.
 *
 * Every entry into sandbox code is a timed slice. With microtaskMode
 * 'afterEvaluate', code after an `await` runs only when the host re-enters
 * the context, so each re-entry runs under the slice limit: a handler call, a
 * settled call's continuation, a timer, reading data out. A slice that runs
 * over is stopped, and Node then drops every other continuation queued in the
 * context, so every pending call fails with it.
 *
 * A trusted bootstrap script runs before any untrusted code. It keeps its own
 * references to the built-ins it uses, so nothing the code later changes can
 * intercept it, and the functions it gives the host only queue work; all
 * decoding and resolving happens inside the timed drain.
 *
 * One constraint on the process: do not enable async_hooks.createHook where
 * sandboxes run. Node aborts the whole process when a slice is stopped inside
 * a promise continuation while a hook is enabled (async hook stack corrupted;
 * Node 24.21). AsyncLocalStorage is fine: on Node 24 it uses no hooks. The
 * node:test runner enables hooks, so a test that stops code after an await
 * runs it in a child process.
 */

import * as vm from 'node:vm';
import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';
import { trackSandbox, type SandboxOwner } from './sandbox-memory.js';
import * as acorn from 'acorn';
import { require as contractRequire, requireNonEmpty, requirePositive, invariant } from './contracts.js';

// ── Errors ──────────────────────────────────────────────────────────────

/** A stretch of code ran past its slice limit and was stopped. */
export class SandboxTimeLimitError extends Error {
  readonly code = 'TIME_LIMIT';
  constructor(readonly limitMs: number) {
    super(`The code ran for more than ${limitMs} ms without pausing and was stopped.`);
    this.name = 'SandboxTimeLimitError';
  }
}

/** The sandbox was stopped while a call was waiting on it. */
export class SandboxStoppedError extends Error {
  readonly code = 'SANDBOX_STOPPED';
  constructor(reason: string) {
    super(`The code was stopped: ${reason}.`);
    this.name = 'SandboxStoppedError';
  }
}

/** The code is waiting on something that can never happen. */
export class SandboxStuckError extends Error {
  readonly code = 'STUCK';
  constructor() {
    super('The code is waiting on something that will never happen: no call is waiting for an answer and no timer is set.');
    this.name = 'SandboxStuckError';
  }
}

/** Source that does not parse, or that uses something the sandbox refuses. */
export class SandboxSourceError extends Error {
  readonly code = 'SOURCE_REJECTED';
  constructor(message: string, readonly line?: number, readonly column?: number) {
    super(message);
    this.name = 'SandboxSourceError';
  }
}

// ── Limits ──────────────────────────────────────────────────────────────

/** Slice limit for compiling a source: it runs at spawn and at boot. */
export const COMPILE_SLICE_MS = 1000;
/** Outstanding helper calls one sandbox may have (the mailbox bound). */
const MAX_TICKETS = 1000;
const MAX_TIMERS = 1000;
const MIN_INTERVAL_MS = 10;
/** Node clamps longer delays to 1 ms; clamp to the longest it accepts instead. */
const MAX_TIMER_MS = 2_147_483_647;
const BOOT_MS = 1000;

// ── The codec, host side ────────────────────────────────────────────────

const TAG = '\u0000abj';
const UNDEFINED_TEXT = JSON.stringify({ [TAG]: 'undef' });
const FALLBACK_REFUSAL = 'e' + JSON.stringify({ name: 'Error', message: 'The host could not answer' });

/** Uint8Array is checked on the holder's own value: toJSON (a Buffer's) has already run on `value`. */
function hostReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];
  if (original instanceof Uint8Array) {
    return { [TAG]: 'u8', d: Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString('latin1') };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return { [TAG]: 'num', v: String(value) };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function hostReviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const tagged = value as Record<string, unknown>;
    const tag = tagged[TAG];
    if (tag === 'u8') return new Uint8Array(Buffer.from(String(tagged.d), 'latin1'));
    if (tag === 'num') return Number(tagged.v);
    if (tag === 'undef') return undefined;
  }
  return value;
}

/** How a tag reads inside JSON text: U+0000 is always escaped there. */
const TAG_TEXT = '\\u0000abj';

/**
 * Whether a value holds anything plain JSON would get wrong: bytes, a
 * non-finite number, a BigInt, or a toJSON that could produce them. Plain
 * JSON keeps V8's fast path, which a replacer or a reviver turns off; with
 * them a copy cost about fifty times as much. Past depth 64 (or a cycle) the
 * slow path decides, and JSON reports a cycle itself.
 */
function needsTags(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  if (value === null || typeof value !== 'object') return false;
  if (depth > 64 || value instanceof Uint8Array) return true;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return true;
  if (Array.isArray(value)) {
    for (const item of value) if (needsTags(item, depth + 1)) return true;
    return false;
  }
  for (const key of Object.keys(value)) {
    if (needsTags((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/** Host value → text the sandbox decodes. Throws on what JSON cannot hold (a cycle). */
function encodeIn(value: unknown): string {
  const text = needsTags(value) ? JSON.stringify(value, hostReplacer) : JSON.stringify(value);
  return typeof text === 'string' ? text : UNDEFINED_TEXT;
}

function decodeOut(text: string): unknown {
  return text.includes(TAG_TEXT) ? JSON.parse(text, hostReviver) : JSON.parse(text);
}

/** An error as data the sandbox turns into one of its own. */
function encodeErrorIn(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; code?: unknown; details?: unknown } | null;
  const info: Record<string, unknown> = {
    name: e && typeof e.name === 'string' ? e.name : 'Error',
    message: err instanceof Error ? err.message : String(err),
  };
  if (e && typeof e.code === 'string') info.code = e.code;
  if (e && e.details !== undefined) {
    try { info.details = decodeOut(encodeIn(e.details)); } catch { /* details that cannot be copied stay behind */ }
  }
  return encodeIn(info);
}

/** A host Error rebuilt from the sandbox's description of one. */
function hostErrorFrom(info: unknown): Error {
  const i = (info !== null && typeof info === 'object' ? info : {}) as Record<string, unknown>;
  const err = new Error(typeof i.message === 'string' ? i.message : 'Error') as Error & { code?: string; details?: unknown };
  if (typeof i.name === 'string' && i.name) err.name = i.name;
  if (typeof i.code === 'string') err.code = i.code;
  if (i.details !== undefined) err.details = i.details;
  err.stack = `${err.name}: ${err.message}${typeof i.stack === 'string' && i.stack ? `\n${i.stack}` : ''}`;
  return err;
}

function refusal(message: string): string {
  return 'e' + JSON.stringify({ name: 'Error', message });
}

/**
 * Node's timeout error is created inside the context, so it is not a host
 * Error. Recognise it by an own data property, which runs no sandbox code.
 */
function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || utilTypes.isProxy(err)) return false;
  const code = Object.getOwnPropertyDescriptor(err, 'code');
  return code !== undefined && 'value' in code && code.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

// ── The bootstrap (runs inside the sandbox, before any untrusted code) ──

const BOOTSTRAP_SOURCE = String.raw`(function abjectSandboxBootstrap(host, configText) {
  'use strict';
  const G = globalThis;
  const ReflectApply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const setPrototypeOf = Object.setPrototypeOf;
  const objectKeys = Object.keys;
  const isArray = Array.isArray;
  const JSONParse = JSON.parse;
  const JSONStringify = JSON.stringify;
  const PromiseCtor = Promise;
  const promiseResolve = Promise.resolve;
  const promiseThen = Promise.prototype.then;
  const MapCtor = Map;
  const mapGet = Map.prototype.get;
  const mapSet = Map.prototype.set;
  const mapHas = Map.prototype.has;
  const mapDelete = Map.prototype.delete;
  const mapClear = Map.prototype.clear;
  const functionBind = Function.prototype.bind;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const StringCtor = String;
  const fromCharCode = String.fromCharCode;
  const charCodeAt = String.prototype.charCodeAt;
  const strSlice = String.prototype.slice;
  const strSplit = String.prototype.split;
  const strIndexOf = String.prototype.indexOf;
  const arrayJoin = Array.prototype.join;
  const U8 = Uint8Array;
  const typedArrayProto = getPrototypeOf(U8.prototype);
  const typedArrayTag = getOwnPropertyDescriptor(typedArrayProto, Symbol.toStringTag).get;
  const typedArrayLength = getOwnPropertyDescriptor(typedArrayProto, 'length').get;
  const typedArraySubarray = typedArrayProto.subarray;
  const numberIsFinite = Number.isFinite;
  const TAG = '\u0000abj';
  const cfg = JSONParse(configText);
  const UNDEF = JSONStringify({ [TAG]: 'undef' });

  // Callbacks and effects these offer would run outside any slice.
  const removed = ['FinalizationRegistry', 'WeakRef', 'Atomics', 'SharedArrayBuffer', 'WebAssembly'];
  for (let i = 0; i < removed.length; i++) delete G[removed[i]];
  try { defineProperty(ErrorCtor, 'prepareStackTrace', { value: undefined, writable: false, enumerable: false, configurable: false }); } catch {}

  // ── codec ──
  function bytesToLatin1(bytes) {
    const n = ReflectApply(typedArrayLength, bytes, []);
    let out = '';
    for (let i = 0; i < n; i += 8192) {
      out += ReflectApply(fromCharCode, null, ReflectApply(typedArraySubarray, bytes, [i, i + 8192 < n ? i + 8192 : n]));
    }
    return out;
  }
  function latin1ToBytes(text) {
    const n = text.length;
    const out = new U8(n);
    const at = ReflectApply(functionBind, charCodeAt, [text]);
    for (let i = 0; i < n; i++) out[i] = at(i);
    return out;
  }
  function replacer(key, value) {
    const original = this[key];
    if (original !== null && typeof original === 'object' && ReflectApply(typedArrayTag, original, []) === 'Uint8Array') {
      return { [TAG]: 'u8', d: bytesToLatin1(original) };
    }
    if (typeof value === 'number' && !numberIsFinite(value)) {
      return { [TAG]: 'num', v: value !== value ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
    }
    if (typeof value === 'bigint') return StringCtor(value);
    return value;
  }
  function reviver(key, value) {
    if (value !== null && typeof value === 'object' && !isArray(value)) {
      const tag = value[TAG];
      if (tag === 'u8') return latin1ToBytes(StringCtor(value.d));
      if (tag === 'num') return value.v === 'NaN' ? NaN : value.v === 'Infinity' ? Infinity : -Infinity;
      if (tag === 'undef') return undefined;
    }
    return value;
  }
  // Plain JSON keeps V8's fast path; tags are needed only for these values.
  function needsTags(value, depth) {
    if (typeof value === 'number') return !numberIsFinite(value);
    if (typeof value === 'bigint') return true;
    if (value === null || typeof value !== 'object') return false;
    if (depth > 64 || ReflectApply(typedArrayTag, value, []) === 'Uint8Array') return true;
    if (typeof value.toJSON === 'function') return true;
    if (isArray(value)) {
      const n = value.length;
      for (let i = 0; i < n; i++) if (needsTags(value[i], depth + 1)) return true;
      return false;
    }
    const keys = objectKeys(value);
    for (let i = 0; i < keys.length; i++) if (needsTags(value[keys[i]], depth + 1)) return true;
    return false;
  }
  function encode(value) {
    const text = needsTags(value, 0) ? JSONStringify(value, replacer) : JSONStringify(value);
    return typeof text === 'string' ? text : UNDEF;
  }
  const TAG_TEXT = '\\u0000abj';
  function decode(text) { return ReflectApply(strIndexOf, text, [TAG_TEXT]) >= 0 ? JSONParse(text, reviver) : JSONParse(text); }

  // ── errors ──
  function asText(v) { return typeof v === 'string' ? v : v === undefined || v === null ? '' : StringCtor(v); }
  function stackOf(e) {
    let all;
    try { all = asText(e.stack); } catch { return ''; }
    const lines = ReflectApply(strSplit, all, ['\n']);
    const kept = [];
    for (let i = 1; i < lines.length; i++) {
      if (ReflectApply(strIndexOf, lines[i], [cfg.filename]) >= 0) kept[kept.length] = lines[i];
    }
    return ReflectApply(arrayJoin, kept, ['\n']);
  }
  function encodeError(e) {
    try {
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        const info = { name: asText(e.name) || 'Error', message: asText(e.message), stack: stackOf(e) };
        if (typeof e.code === 'string') info.code = e.code;
        if (e.details !== undefined) { try { info.details = decode(encode(e.details)); } catch {} }
        return encode(info);
      }
      return encode({ name: 'Error', message: asText(e) });
    } catch {
      return encode({ name: 'Error', message: 'An error was thrown that could not be described' });
    }
  }
  function errorFrom(info) {
    const ok = info !== null && typeof info === 'object';
    const e = new ErrorCtor(ok && typeof info.message === 'string' ? info.message : 'Error');
    if (ok) {
      if (typeof info.name === 'string') defineProperty(e, 'name', { value: info.name, writable: true, enumerable: false, configurable: true });
      if (typeof info.code === 'string') defineProperty(e, 'code', { value: info.code, writable: true, enumerable: true, configurable: true });
      if (info.details !== undefined) defineProperty(e, 'details', { value: info.details, writable: true, enumerable: true, configurable: true });
    }
    return e;
  }

  // ── the host ──
  // Arguments and answers are strings and numbers. Whatever the host throws,
  // stack overflow at the call included, stays in this catch.
  function callHost(op, a, b, c) {
    let reply;
    try { reply = host(op, a, b, c); } catch { throw new ErrorCtor('The host could not take this call'); }
    return typeof reply === 'string' ? reply : 'e' + encode({ name: 'Error', message: 'The host gave no answer' });
  }
  function answerOf(reply) {
    const kind = ReflectApply(strSlice, reply, [0, 1]);
    const body = ReflectApply(strSlice, reply, [1]);
    if (kind === 'v') return decode(body);
    throw errorFrom(decode(body));
  }

  let ticketSeq = 0;
  const tickets = new MapCtor();
  function asyncHelper(name) {
    return function (...args) {
      return (async () => {
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a !== null && (typeof a === 'object' || typeof a === 'function') && typeof a.then === 'function') args[i] = await a;
        }
        const payload = encode(args);
        const ticket = ++ticketSeq;
        const answered = new PromiseCtor((resolve, reject) => { ReflectApply(mapSet, tickets, [ticket, [resolve, reject]]); });
        const reply = callHost('async', ticket, name, payload);
        if (reply !== '') { ReflectApply(mapDelete, tickets, [ticket]); return answerOf(reply); }
        return answered;
      })();
    };
  }
  function syncHelper(name) {
    return function (...args) { return answerOf(callHost('sync', 0, name, encode(args))); };
  }

  let timerSeq = 0;
  const timerCallbacks = new MapCtor();
  function timerSetter(repeat) {
    return function (callback, delay, ...args) {
      if (typeof callback !== 'function') throw new TypeErrorCtor('A timer callback must be a function');
      const id = ++timerSeq;
      ReflectApply(mapSet, timerCallbacks, [id, [callback, args, repeat]]);
      const reply = callHost('timer', id, typeof delay === 'number' && delay > 0 ? delay : 0, repeat ? 'interval' : 'timeout');
      if (reply !== '') { ReflectApply(mapDelete, timerCallbacks, [id]); answerOf(reply); }
      return id;
    };
  }
  function clearTimer(id) {
    if (typeof id !== 'number' || !ReflectApply(mapHas, timerCallbacks, [id])) return;
    ReflectApply(mapDelete, timerCallbacks, [id]);
    callHost('timer', id, 0, 'clear');
  }

  // ── answers to the host ──
  let outbox = '';
  function report(id, kind, body) { outbox += '\u0001' + id + '\u0002' + kind + '\u0002' + body; }
  function reportValue(id, okKind, errKind, value) {
    let body;
    try { body = encode(value); } catch (e) { report(id, errKind, encodeError(e)); return; }
    report(id, okKind, body);
  }
  function settleResult(id, result) {
    let thenable;
    try { thenable = result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function'; }
    catch (e) { report(id, 'e', encodeError(e)); return; }
    if (!thenable) { reportValue(id, 'v', 'e', result); return; }
    try {
      ReflectApply(promiseThen, ReflectApply(promiseResolve, PromiseCtor, [result]), [
        (value) => reportValue(id, 'V', 'E', value),
        (error) => report(id, 'E', encodeError(error)),
      ]);
    } catch (e) { report(id, 'e', encodeError(e)); }
  }

  // ── data, contracts, handlers ──
  let data = {};
  function readData() { return data; }
  function readId() { return answerOf(callHost('sync', 0, 'id', '[]')); }
  function ensure(condition, message) {
    if (!condition) throw new ErrorCtor('ContractViolation (ensure): ' + (message === undefined ? 'condition failed' : message));
  }
  function invariant(condition, message) {
    if (!condition) throw new ErrorCtor('ContractViolation (invariant): ' + (message === undefined ? 'invariant failed' : message));
  }

  const helpers = {};
  for (let i = 0; i < cfg.async.length; i++) helpers[cfg.async[i]] = asyncHelper(cfg.async[i]);
  for (let i = 0; i < cfg.sync.length; i++) helpers[cfg.sync[i]] = syncHelper(cfg.sync[i]);
  if (cfg.contracts) { helpers.ensure = ensure; helpers.invariant = invariant; }
  const helperNames = objectKeys(helpers);
  for (let i = 0; i < helperNames.length; i++) {
    defineProperty(G, helperNames[i], { value: helpers[helperNames[i]], writable: true, enumerable: false, configurable: true });
  }
  if (cfg.liveId) defineProperty(G, 'id', { get: readId, enumerable: false, configurable: true });
  if (cfg.data) defineProperty(G, 'data', { get: readData, enumerable: false, configurable: true });
  defineProperty(G, 'console', { value: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, writable: true, enumerable: false, configurable: true });
  if (cfg.timers) {
    defineProperty(G, 'setTimeout', { value: timerSetter(false), writable: true, enumerable: false, configurable: true });
    defineProperty(G, 'setInterval', { value: timerSetter(true), writable: true, enumerable: false, configurable: true });
    defineProperty(G, 'clearTimeout', { value: clearTimer, writable: true, enumerable: false, configurable: true });
    defineProperty(G, 'clearInterval', { value: clearTimer, writable: true, enumerable: false, configurable: true });
  }

  const handlers = new MapCtor();
  let self;
  function installHandlers(map) {
    if (map === null || typeof map !== 'object') throw new TypeErrorCtor('Source must evaluate to a non-null object');
    if (cfg.inherited.length > 0) {
      // super.<name>(...) in a method of the map reaches what the host
      // inherits under that name.
      const parent = {};
      for (let i = 0; i < cfg.inherited.length; i++) {
        defineProperty(parent, cfg.inherited[i], { value: asyncHelper('super.' + cfg.inherited[i]), writable: false, enumerable: false, configurable: false });
      }
      try { setPrototypeOf(map, parent); } catch {}
    }
    const target = {};
    for (let i = 0; i < helperNames.length; i++) {
      defineProperty(target, helperNames[i], { value: helpers[helperNames[i]], writable: true, enumerable: true, configurable: true });
    }
    if (cfg.liveId) defineProperty(target, 'id', { get: readId, enumerable: true, configurable: false });
    if (cfg.data) defineProperty(target, 'data', { get: readData, enumerable: true, configurable: false });
    const reserved = cfg.reserved;
    const installed = new MapCtor();
    const list = [];
    const keys = objectKeys(map);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = map[key];
      let isReserved = false;
      for (let j = 0; j < reserved.length; j++) if (reserved[j] === key) isReserved = true;
      if (typeof value === 'function') {
        // Every function is callable by name (a handler named like a helper
        // still receives its messages); only unreserved ones join 'this'.
        const bound = ReflectApply(functionBind, value, [target]);
        ReflectApply(mapSet, installed, [key, bound]);
        if (!isReserved) defineProperty(target, key, { value: bound, writable: true, enumerable: true, configurable: true });
        list[list.length] = [key, 'function'];
      } else {
        if (!isReserved) defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
        list[list.length] = [key, 'value'];
      }
    }
    // Swapped in whole, only once the map installed without throwing.
    ReflectApply(mapClear, handlers, []);
    for (let i = 0; i < list.length; i++) {
      const name = list[i][0];
      if (ReflectApply(mapHas, installed, [name])) ReflectApply(mapSet, handlers, [name, ReflectApply(mapGet, installed, [name])]);
    }
    self = target;
    return list;
  }

  // ── compiling: the host's script hands its function here ──
  const compiled = new MapCtor();
  let expected = 0;
  function accept(id, fn, kind) {
    if (expected === 0 || id !== expected) return;
    expected = 0;
    if (kind === 'function') { ReflectApply(mapSet, compiled, [id, fn]); report(id, 'c', UNDEF); return; }
    let list;
    try { list = installHandlers(fn()); } catch (e) { report(id, 'e', encodeError(e)); return; }
    reportValue(id, 'c', 'e', list);
  }

  // ── the work the host queued ──
  function runCall(id, target, body) {
    if (target === '#readData') { reportValue(id, 'v', 'e', data); return; }
    if (target === '#writeData') {
      let value;
      try { value = decode(body); } catch (e) { report(id, 'e', encodeError(e)); return; }
      data = value !== null && typeof value === 'object' && !isArray(value) ? value : {};
      report(id, 'v', UNDEF);
      return;
    }
    const fn = typeof target === 'number' ? ReflectApply(mapGet, compiled, [target]) : ReflectApply(mapGet, handlers, [target]);
    if (typeof fn !== 'function') { report(id, 'e', encode({ name: 'Error', message: 'Nothing to call named ' + target })); return; }
    let args;
    try { args = decode(body); } catch (e) { report(id, 'e', encodeError(e)); return; }
    let result;
    try { result = ReflectApply(fn, typeof target === 'number' ? undefined : self, isArray(args) ? args : []); }
    catch (e) { report(id, 'e', encodeError(e)); return; }
    settleResult(id, result);
  }
  function runSettle(ticket, ok, body) {
    const entry = ReflectApply(mapGet, tickets, [ticket]);
    if (!entry) return;
    ReflectApply(mapDelete, tickets, [ticket]);
    let value;
    try { value = decode(body); } catch (e) { entry[1](e); return; }
    if (ok) entry[0](value); else entry[1](errorFrom(value));
  }
  function runTimer(id) {
    const entry = ReflectApply(mapGet, timerCallbacks, [id]);
    if (!entry) return;
    if (!entry[2]) ReflectApply(mapDelete, timerCallbacks, [id]);
    try { ReflectApply(entry[0], undefined, entry[1]); } catch (e) { report(0, 'u', encodeError(e)); }
  }
  function runGlobal(name, body) {
    let value;
    try { value = decode(body); } catch (e) { report(0, 'u', encodeError(e)); return; }
    defineProperty(G, name, { value: value, writable: true, enumerable: true, configurable: true });
  }

  const queue = new MapCtor();
  let head = 0;
  let tail = 0;
  function drain() {
    while (head < tail) {
      const at = head;
      head = at + 1;
      const item = ReflectApply(mapGet, queue, [at]);
      ReflectApply(mapDelete, queue, [at]);
      if (!item) continue;
      try {
        const kind = item[0];
        if (kind === 'call') runCall(item[1], item[2], item[3]);
        else if (kind === 'settle') runSettle(item[1], item[2] === 1, item[3]);
        else if (kind === 'timer') runTimer(item[1]);
        else if (kind === 'global') runGlobal(item[2], item[3]);
        else if (kind === 'reset') { ReflectApply(mapClear, tickets, []); ReflectApply(mapClear, timerCallbacks, []); }
      } catch (e) { report(0, 'u', encodeError(e)); }
    }
  }
  defineProperty(G, '__abjectDrain__', { value: drain, writable: false, enumerable: false, configurable: false });
  defineProperty(G, '__abjectAccept__', { value: accept, writable: false, enumerable: false, configurable: false });

  // Called by the host outside any slice: they touch only their own closures.
  return {
    post(kind, a, b, c) { ReflectApply(mapSet, queue, [tail, [kind, a, b, c]]); tail = tail + 1; },
    take() { const out = outbox; outbox = ''; return out; },
    expect(id) { expected = id; },
  };
})`;

const BOOTSTRAP = new vm.Script(BOOTSTRAP_SOURCE, { filename: 'abject-sandbox-bootstrap.js' });
const DRAIN = new vm.Script('__abjectDrain__()', { filename: 'abject-sandbox-drain.js' });

interface BootstrapApi {
  post(kind: string, a: number, b?: number | string, c?: string): void;
  take(): string;
  expect(id: number): void;
}
type Boot = (host: (op: unknown, a: unknown, b: unknown, c: unknown) => string, configText: string) => BootstrapApi;

// ── Checking source before it runs ──────────────────────────────────────

type SourceKind = 'body' | 'expression' | 'handlers';

/** Called where the sandbox has nothing to call: the guidance names what to do instead. */
const UNAVAILABLE_CALLS = new Set(['require', 'fetch', 'importScripts']);
const UNAVAILABLE_NAMES = new Set(['process', 'XMLHttpRequest', 'WebSocket']);
const STRING_COMPILERS = new Set(['eval', 'Function']);

interface AstNode { type: string; start: number; end: number; [key: string]: unknown }

function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  const n = node as AstNode;
  if (typeof n.type !== 'string') return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walk(n[key], visit);
  }
}

function declaredNames(program: AstNode): Set<string> {
  const names = new Set<string>();
  const bind = (pattern: unknown): void => {
    walk(pattern, n => { if (n.type === 'Identifier') names.add(n.name as string); });
  };
  walk(program, n => {
    if (n.type === 'VariableDeclarator') bind(n.id);
    else if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ClassDeclaration') && n.id) bind(n.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') bind(n.params);
    else if (n.type === 'CatchClause' && n.param) bind(n.param);
  });
  return names;
}

/**
 * Wrap source in the script that hands its function to the bootstrap, after
 * proving with acorn that the source stays inside its wrapper: the parsed
 * script must be exactly one call with the arguments this module wrote.
 */
function wrapSource(source: string, id: number, kind: SourceKind, params: readonly string[], guidance: boolean): string {
  const arrow = kind === 'body' ? 'async () => {' : `(${params.join(', ')}) => (`;
  const prefix = `__abjectAccept__(${id}, ${arrow}`;
  const closer = kind === 'body' ? '}' : ')';
  const tag = kind === 'handlers' ? 'handlers' : 'function';
  const text = `${prefix}\n${source}\n${closer}, '${tag}')`;

  let program: AstNode;
  try {
    program = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true }) as unknown as AstNode;
  } catch (err) {
    const e = err as { message?: string; loc?: { line: number; column: number } };
    const line = e.loc ? e.loc.line - 1 : undefined;
    const reason = (e.message ?? String(err)).replace(/\s*\(\d+:\d+\)$/, '');
    throw new SandboxSourceError(line !== undefined && line >= 1 ? `${reason} (line ${line}, column ${(e.loc?.column ?? 0) + 1})` : reason, line, e.loc?.column);
  }

  const body = program.body as AstNode[];
  const statement = body.length === 1 ? body[0] : undefined;
  const call = statement?.type === 'ExpressionStatement' ? statement.expression as AstNode : undefined;
  const args = call?.type === 'CallExpression' ? call.arguments as AstNode[] : [];
  const fn = args[1];
  const arrowStart = prefix.length - arrow.length;
  const arrowEnd = prefix.length + 1 + source.length + 1 + closer.length;
  const shaped = !!call
    && (call.callee as AstNode).type === 'Identifier' && (call.callee as AstNode).name === '__abjectAccept__'
    && args.length === 3
    && args[0].type === 'Literal' && args[0].value === id
    && fn.type === 'ArrowFunctionExpression' && fn.start === arrowStart && fn.end === arrowEnd
    && (fn.async === true) === (kind === 'body')
    && (fn.params as AstNode[]).length === params.length
    && args[2].type === 'Literal' && args[2].value === tag;
  if (!shaped) throw new SandboxSourceError(kind === 'handlers' ? 'Source must be a single expression' : 'Source does not stand on its own');

  const declared = guidance ? declaredNames(program) : new Set<string>();
  const missing = (name: string): SandboxSourceError => new SandboxSourceError(
    `'${name}' does not exist here. Reach what it would provide by message: dep() or find() resolves the object that offers it, call() sends it a message.`);
  walk(fn.body, n => {
    if (n.type === 'ImportExpression' || (n.type === 'MetaProperty' && (n.meta as AstNode).name === 'import')) {
      throw new SandboxSourceError('import() and import.meta are not available here. Reach other objects by message: dep() or find() resolves one, call() sends it a message.');
    }
    if (!guidance) return;
    // Only a name used as a value: `obj.process` and `{ fetch: 1 }` are fine.
    const callee = (n.type === 'CallExpression' || n.type === 'NewExpression') ? n.callee as AstNode : undefined;
    if (callee?.type === 'Identifier' && !declared.has(callee.name as string)) {
      const name = callee.name as string;
      if (STRING_COMPILERS.has(name)) throw new SandboxSourceError(`${name}() is not available here: code cannot be compiled from strings.`);
      if (UNAVAILABLE_CALLS.has(name) || UNAVAILABLE_NAMES.has(name)) throw missing(name);
    }
    const object = n.type === 'MemberExpression' ? n.object as AstNode : undefined;
    if (object?.type === 'Identifier' && UNAVAILABLE_NAMES.has(object.name as string) && !declared.has(object.name as string)) {
      throw missing(object.name as string);
    }
  });
  return text;
}

// ── The sandbox ─────────────────────────────────────────────────────────

/** Arguments arrive as decoded copies of whatever the code passed; check them as such. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Helper = (...args: any[]) => unknown;

export interface SandboxOptions {
  /** Shown in stack traces and kept in error stacks. */
  filename: string;
  /** Longest a single stretch of code may run before it is stopped, in ms. */
  sliceMs: number;
  /** Helpers code calls and awaits. Each gets copies and answers with data or a promise of data. */
  asyncHelpers?: Record<string, Helper>;
  /** Helpers that answer at once. `id`, if present, becomes a live `id` value instead of a function. */
  syncHelpers?: Record<string, Helper>;
  /** setTimeout, setInterval, clearTimeout and clearInterval. */
  timers?: boolean;
  /** ensure() and invariant(). */
  contracts?: boolean;
  /** A `data` record, live as `data` and `this.data`, read and written as copies. */
  data?: boolean;
  /** Handler-map names that do not replace a helper on `this`. */
  reservedNames?: readonly string[];
  /**
   * What a handler map inherits: inside a method written in method syntax,
   * `super.<name>(...args)` calls the helper here with copies and awaits it.
   */
  inherited?: Record<string, Helper>;
  /**
   * Fail a call that waits while nothing can ever wake it: no helper call
   * outstanding and no timer set. Only where no other call can enter the
   * sandbox (a job); a handler may be woken by the next message.
   */
  failStuckCalls?: boolean;
  /** After every stretch of code that ran to its end. */
  onSlice?: () => void;
  /** A stretch ran past sliceMs and was stopped; pending calls and timers are gone. */
  onInterrupt?: (err: SandboxTimeLimitError) => void;
  /** An error nobody awaits, such as one thrown by a timer callback. */
  onUncaught?: (err: Error) => void;
  /**
   * The abject whose code this is, so the memory the sandbox holds can be
   * put down to it (sandbox-memory.ts). Asked when memory is measured, since
   * an object learns its id after it is built.
   */
  owner?: () => SandboxOwner;
}

export type SandboxOutcome =
  | { sync: true; value: unknown }
  | { sync: false; promise: Promise<unknown> };

interface Invocation {
  outcome?: { ok: true; value: unknown; sync: boolean } | { ok: false; error: Error; sync: boolean };
  resolve?: (value: unknown) => void;
  reject?: (err: Error) => void;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export class Sandbox {
  private ctx: vm.Context | undefined;
  private readonly api: BootstrapApi;
  private readonly sliceMs: number;
  private readonly asyncHelpers: Record<string, Helper>;
  private readonly syncHelpers: Record<string, Helper>;
  private readonly inherited: Record<string, Helper>;
  private seq = 0;
  private readonly invocations = new Map<number, Invocation>();
  private readonly tickets = new Set<number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private inSlice = false;
  private stoppedReason?: string;
  private stuckCheckQueued = false;

  constructor(private readonly options: SandboxOptions) {
    requireNonEmpty(options.filename, 'filename');
    requirePositive(options.sliceMs, 'sliceMs');
    this.sliceMs = options.sliceMs;
    this.asyncHelpers = { ...(options.asyncHelpers ?? {}) };
    this.syncHelpers = { ...(options.syncHelpers ?? {}) };
    this.inherited = { ...(options.inherited ?? {}) };
    for (const name of [...Object.keys(this.asyncHelpers), ...Object.keys(this.syncHelpers), ...Object.keys(this.inherited)]) {
      contractRequire(IDENTIFIER.test(name), `helper name must be an identifier: ${name}`);
    }
    const config = {
      filename: options.filename,
      async: Object.keys(this.asyncHelpers),
      sync: Object.keys(this.syncHelpers).filter(n => n !== 'id'),
      liveId: 'id' in this.syncHelpers,
      data: !!options.data,
      timers: !!options.timers,
      contracts: !!options.contracts,
      reserved: [...(options.reservedNames ?? [])],
      inherited: Object.keys(this.inherited),
    };
    this.ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
      name: options.filename,
      microtaskMode: 'afterEvaluate',
      codeGeneration: { strings: false, wasm: false },
    });
    trackSandbox(this.ctx, this);
    const boot = BOOTSTRAP.runInContext(this.ctx, { timeout: BOOT_MS }) as Boot;
    // Read once, before any untrusted code has run.
    const api = boot(this.hostEntry, JSON.stringify(config));
    this.api = { post: api.post, take: api.take, expect: api.expect };
  }

  /** Stopped for good: nothing more runs. */
  get stopped(): boolean {
    return this.stoppedReason !== undefined;
  }

  /** The abject whose code this is, if it said. */
  get owner(): SandboxOwner | undefined {
    return this.options.owner?.();
  }

  /** No helper call is waiting for an answer and no timer is set: only a new call can run code. */
  get idle(): boolean {
    return this.tickets.size === 0 && this.timers.size === 0;
  }

  // ── Loading code ──

  /** Install data values as globals (copies). */
  setGlobals(values: Record<string, unknown>): void {
    this.requireLive();
    let posted = false;
    for (const [name, value] of Object.entries(values)) {
      contractRequire(IDENTIFIER.test(name), `global name must be an identifier: ${name}`);
      this.api.post('global', 0, name, encodeIn(value));
      posted = true;
    }
    if (posted) this.runSlice(DRAIN);
  }

  /** Compile an async function body (job code). Returns what `invoke` calls. */
  compileBody(code: string): number {
    return this.compile(code, 'body', [], true).id;
  }

  /** Compile one expression over the named parameters (a trigger filter). */
  compileExpression(expression: string, params: readonly string[]): number {
    for (const p of params) contractRequire(IDENTIFIER.test(p), `parameter must be an identifier: ${p}`);
    return this.compile(expression, 'expression', params, true).id;
  }

  /**
   * Evaluate a handler map (an object expression) and make it `this` for its
   * functions, alongside the helpers. Returns every key and whether it is a
   * function; replaces any handlers installed before.
   */
  installHandlers(source: string): Array<{ name: string; kind: 'function' | 'value' }> {
    const list = this.compile(source, 'handlers', [], false).value;
    contractRequire(Array.isArray(list), 'installing handlers answers with their names');
    return (list as Array<[string, 'function' | 'value']>).map(([name, kind]) => ({ name, kind }));
  }

  /** Static check only: does this source parse, stay in its wrapper, and use nothing refused? */
  static checkSource(source: string, kind: SourceKind, params: readonly string[] = []): void {
    wrapSource(source, 1, kind, params, kind !== 'handlers');
  }

  /** Compile a handler map in a throwaway sandbox; returns the names of its functions. */
  static checkHandlers(source: string, filename: string): string[] {
    const sandbox = new Sandbox({ filename, sliceMs: COMPILE_SLICE_MS, data: true, contracts: true, timers: true });
    try {
      return sandbox.installHandlers(source).filter(h => h.kind === 'function').map(h => h.name);
    } finally {
      sandbox.dispose('compile check finished');
    }
  }

  // ── Running code ──

  /**
   * Call a compiled function (by the number compile returned) or an installed
   * handler (by name). A call that answers synchronously answers here; one
   * that returns a promise answers through `promise`. Throws what it threw.
   */
  invoke(target: number | string, args: readonly unknown[] = []): SandboxOutcome {
    this.requireLive();
    const encoded = encodeIn(args);
    const id = ++this.seq;
    const inv: Invocation = {};
    this.invocations.set(id, inv);
    this.api.post('call', id, target, encoded);
    this.runSlice(DRAIN);
    return this.outcomeOf(id, inv);
  }

  /** `invoke`, always as a promise. */
  run(target: number | string, args: readonly unknown[] = []): Promise<unknown> {
    try {
      const outcome = this.invoke(target, args);
      return outcome.sync ? Promise.resolve(outcome.value) : outcome.promise;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** A copy of the `data` record. Throws when it cannot be copied (a cycle). */
  readData(): Record<string, unknown> {
    const outcome = this.invoke('#readData');
    invariant(outcome.sync, 'reading data answers at once');
    const value = (outcome as { value: unknown }).value;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  /** Replace the `data` record with a copy of `value`. */
  writeData(value: Record<string, unknown>): void {
    this.requireLive();
    const encoded = encodeIn(value);
    const id = ++this.seq;
    const inv: Invocation = {};
    this.invocations.set(id, inv);
    this.api.post('call', id, '#writeData', encoded);
    this.runSlice(DRAIN);
    const outcome = this.outcomeOf(id, inv);
    invariant(outcome.sync, 'writing data answers at once');
  }

  /** Stop for good: timers cancelled, late answers discarded, waiting calls failed. */
  dispose(reason = 'it was stopped'): void {
    if (this.stoppedReason !== undefined) return;
    this.stoppedReason = reason;
    this.clearTimers();
    this.tickets.clear();
    this.failAll(new SandboxStoppedError(reason));
    this.ctx = undefined;
  }

  // ── Internals ──

  private requireLive(): void {
    if (this.stoppedReason !== undefined) throw new SandboxStoppedError(this.stoppedReason);
  }

  private compile(source: string, kind: SourceKind, params: readonly string[], guidance: boolean): { id: number; value: unknown } {
    this.requireLive();
    const id = ++this.seq;
    const text = wrapSource(source, id, kind, params, guidance);
    let script: vm.Script;
    try {
      script = new vm.Script(text, { filename: this.options.filename, lineOffset: -1 });
    } catch (err) {
      // V8 found an early error acorn did not; the error is the host's own.
      const e = err as Error;
      const line = /:(\d+)\n/.exec(e.stack ?? '')?.[1];
      throw new SandboxSourceError(line ? `${e.message} (line ${line})` : e.message, line ? Number(line) : undefined);
    }
    const inv: Invocation = {};
    this.invocations.set(id, inv);
    this.api.expect(id);
    this.runSlice(script);
    this.api.expect(0);
    this.invocations.delete(id);
    const outcome = inv.outcome;
    if (!outcome) throw new SandboxStoppedError(this.stoppedReason ?? 'compiling produced no answer');
    if (!outcome.ok) throw outcome.error;
    return { id, value: outcome.value };
  }

  private outcomeOf(id: number, inv: Invocation): SandboxOutcome {
    const outcome = inv.outcome;
    if (outcome) {
      this.invocations.delete(id);
      if (outcome.sync) {
        if (outcome.ok) return { sync: true, value: outcome.value };
        throw outcome.error;
      }
      return { sync: false, promise: outcome.ok ? Promise.resolve(outcome.value) : Promise.reject(outcome.error) };
    }
    const promise = new Promise<unknown>((resolve, reject) => { inv.resolve = resolve; inv.reject = reject; });
    if (this.options.failStuckCalls) this.queueStuckCheck();
    return { sync: false, promise };
  }

  /** Run sandbox code under the slice limit, then hand out what it answered. */
  private runSlice(script: vm.Script): void {
    const ctx = this.ctx;
    if (this.stoppedReason !== undefined || !ctx) return;
    contractRequire(!this.inSlice, 'a sandbox slice cannot start inside another');
    this.inSlice = true;
    let interrupted = false;
    let failed = false;
    try {
      script.runInContext(ctx, { timeout: this.sliceMs });
    } catch (err) {
      // Anything else thrown here came out of the sandbox: never look inside it.
      if (isTimeout(err)) interrupted = true; else failed = true;
    } finally {
      this.inSlice = false;
    }
    this.deliver(this.api.take());
    if (interrupted) this.interrupt();
    else if (failed) this.dispose('it failed outside any call');
    else {
      this.options.onSlice?.();
      if (this.options.failStuckCalls) this.queueStuckCheck();
    }
  }

  private deliver(out: unknown): void {
    if (typeof out !== 'string' || out === '') return;
    for (const entry of out.split('\u0001')) {
      if (!entry) continue;
      const first = entry.indexOf('\u0002');
      const second = entry.indexOf('\u0002', first + 1);
      if (first < 0 || second < 0) continue;
      const id = Number(entry.slice(0, first));
      const kind = entry.slice(first + 1, second);
      const body = entry.slice(second + 1);
      let value: unknown;
      try { value = decodeOut(body); } catch { value = { message: 'An answer from the code could not be read' }; }
      if (kind === 'u') {
        this.options.onUncaught?.(hostErrorFrom(value));
        continue;
      }
      const inv = this.invocations.get(id);
      if (!inv) continue;
      const ok = kind === 'v' || kind === 'V' || kind === 'c';
      const sync = kind === 'v' || kind === 'e' || kind === 'c';
      const outcome = ok
        ? { ok: true as const, value, sync }
        : { ok: false as const, error: hostErrorFrom(value), sync };
      if (!sync && inv.resolve) {
        this.invocations.delete(id);
        if (outcome.ok) inv.resolve(outcome.value); else inv.reject!(outcome.error);
      } else {
        inv.outcome = outcome;
      }
    }
  }

  /**
   * A slice ran over. Node dropped the context's queued continuations with it,
   * so nothing waiting can finish: fail it all, and clear timers and calls.
   * The context itself stays usable; the owner decides whether to go on.
   */
  private interrupt(): void {
    const err = new SandboxTimeLimitError(this.sliceMs);
    this.clearTimers();
    this.tickets.clear();
    this.failAll(err);
    const ctx = this.ctx;
    if (ctx) {
      this.api.post('reset', 0);
      try { DRAIN.runInContext(ctx, { timeout: this.sliceMs }); } catch { /* clearing two maps cannot run over */ }
      this.api.take();
    }
    this.options.onInterrupt?.(err);
  }

  private failAll(err: Error): void {
    for (const inv of this.invocations.values()) {
      if (inv.reject) inv.reject(err);
      else inv.outcome = { ok: false, error: err, sync: true };
    }
    this.invocations.clear();
  }

  private clearTimers(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }

  private queueStuckCheck(): void {
    if (this.stuckCheckQueued) return;
    this.stuckCheckQueued = true;
    queueMicrotask(() => {
      this.stuckCheckQueued = false;
      if (this.stoppedReason !== undefined || this.inSlice || !this.idle) return;
      const waiting = [...this.invocations.entries()].filter(([, inv]) => inv.reject && !inv.outcome);
      if (waiting.length === 0) return;
      const err = new SandboxStuckError();
      for (const [id, inv] of waiting) { this.invocations.delete(id); inv.reject!(err); }
    });
  }

  // ── The one way out of the sandbox ──

  /**
   * Called from inside the sandbox with strings and numbers; answers with a
   * string and never throws. 'v' + data or 'e' + error for sync helpers, ''
   * when an async call or timer was accepted.
   */
  private readonly hostEntry = (op: unknown, a: unknown, b: unknown, c: unknown): string => {
    try {
      if (this.stoppedReason !== undefined) return refusal('The code has been stopped');
      if (op === 'sync' && typeof b === 'string' && typeof c === 'string') return this.callSync(b, c);
      if (op === 'async' && typeof a === 'number' && typeof b === 'string' && typeof c === 'string') return this.callAsync(a, b, c);
      if (op === 'timer' && typeof a === 'number' && typeof b === 'number' && typeof c === 'string') return this.timer(a, b, c);
      return refusal('Unknown request');
    } catch (err) {
      try { return 'e' + encodeErrorIn(err); } catch { return FALLBACK_REFUSAL; }
    }
  };

  private callSync(name: string, argsText: string): string {
    const fn = Object.prototype.hasOwnProperty.call(this.syncHelpers, name) ? this.syncHelpers[name] : undefined;
    if (!fn) return refusal(`${name} is not available here`);
    const args = decodeOut(argsText);
    if (!Array.isArray(args)) return refusal('Malformed arguments');
    const value = fn(...args);
    if (value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
      return refusal(`${name} cannot answer at once`);
    }
    return 'v' + encodeIn(value);
  }

  private callAsync(ticket: number, name: string, argsText: string): string {
    const [helpers, key] = name.startsWith('super.') ? [this.inherited, name.slice(6)] : [this.asyncHelpers, name];
    const fn = Object.prototype.hasOwnProperty.call(helpers, key) ? helpers[key] : undefined;
    if (!fn) return refusal(`${name} is not available here`);
    if (this.tickets.size >= MAX_TICKETS) return refusal(`More than ${MAX_TICKETS} calls are already waiting for answers`);
    const args = decodeOut(argsText);
    if (!Array.isArray(args)) return refusal('Malformed arguments');
    this.tickets.add(ticket);
    // Started after the slice ends, so a helper may enter the sandbox itself.
    queueMicrotask(() => {
      let result: unknown;
      try { result = fn(...args); } catch (err) { this.settle(ticket, false, err); return; }
      Promise.resolve(result).then(
        value => this.settle(ticket, true, value),
        err => this.settle(ticket, false, err),
      );
    });
    return '';
  }

  private settle(ticket: number, ok: boolean, value: unknown): void {
    if (this.stoppedReason !== undefined || !this.tickets.has(ticket)) return;
    if (this.inSlice) { queueMicrotask(() => this.settle(ticket, ok, value)); return; }
    this.tickets.delete(ticket);
    let body: string;
    let delivered = ok;
    try {
      body = ok ? encodeIn(value) : encodeErrorIn(value);
    } catch (err) {
      delivered = false;
      body = encodeErrorIn(new Error(`The answer could not be copied into the sandbox: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.api.post('settle', ticket, delivered ? 1 : 0, body);
    this.runSlice(DRAIN);
  }

  private timer(id: number, delay: number, kind: string): string {
    if (kind === 'clear') {
      const handle = this.timers.get(id);
      if (handle !== undefined) { clearTimeout(handle); this.timers.delete(id); }
      return '';
    }
    if (this.timers.size >= MAX_TIMERS) return refusal(`More than ${MAX_TIMERS} timers are already set`);
    const repeat = kind === 'interval';
    const ms = Math.min(MAX_TIMER_MS, Math.max(repeat ? MIN_INTERVAL_MS : 1, Number.isFinite(delay) ? delay : 0));
    const fire = (): void => {
      if (!repeat) this.timers.delete(id);
      if (this.stoppedReason !== undefined) return;
      this.api.post('timer', id);
      this.runSlice(DRAIN);
    };
    this.timers.set(id, repeat ? setInterval(fire, ms) : setTimeout(fire, ms));
    return '';
  }
}
