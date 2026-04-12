/**
 * Sandbox — shared code-sandboxing library for safe execution of untrusted JavaScript.
 *
 * Uses Node.js `vm` module to create isolated contexts with only safe built-ins
 * and caller-provided helpers. No require, fetch, process, globalThis, or other
 * Node.js/browser globals are available inside the sandbox.
 *
 * Consumers (JobManager, HttpServer, ScriptableAbject) compose their own context
 * dictionaries and pass them in alongside the standard built-ins.
 */

import * as vm from 'vm';
import { require as contractRequire, requireNonEmpty } from './contracts.js';

/**
 * Safe built-in globals exposed inside every sandbox context.
 * Used both to build the vm.createContext() and to generate ask-protocol guides.
 */
export const SANDBOX_BUILTINS: Record<string, unknown> = {
  Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp,
  Map, Set, Promise, Error, TypeError, RangeError,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  // Timer functions are safe: callbacks execute within the same sandbox context.
  setTimeout, setInterval, clearTimeout, clearInterval,
  console: { log() {}, warn() {}, error() {} },
};

/** Names of builtins (excluding console) for prompt/documentation generation. */
export const SANDBOX_BUILTIN_NAMES = Object.keys(SANDBOX_BUILTINS).filter(k => k !== 'console');

/**
 * Patterns that must never appear in sandboxed code. Defence-in-depth:
 * the vm context also shadows these globals, but rejecting early gives
 * clear error messages and prevents creative workarounds.
 */
export const BLOCKED_CODE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\bexecSync\b/, label: 'execSync' },
  { pattern: /\bexecFile\b/, label: 'execFile' },
  { pattern: /\bspawnSync\b/, label: 'spawnSync' },
  { pattern: /\bprocess\s*\.\s*(exit|kill|env|execPath|binding)/, label: 'process.*' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  { pattern: /\bglobal\s*[.\[]/, label: 'global' },
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
  { pattern: /\bfetch\s*\(/, label: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
];

/**
 * Validate code against blocked patterns.
 * Returns `{ valid: true }` if clean, or `{ valid: false, blocked: 'label' }` on match.
 */
export function validateCode(code: string): { valid: boolean; blocked?: string } {
  for (const { pattern, label } of BLOCKED_CODE_PATTERNS) {
    if (pattern.test(code)) {
      return { valid: false, blocked: label };
    }
  }
  return { valid: true };
}

export interface SandboxOptions {
  /** Filename for stack traces. */
  filename?: string;
  /** Timeout in milliseconds for synchronous execution (does not cover awaited Promises). */
  timeout?: number;
}

/**
 * Run a code string in a sandboxed vm context.
 *
 * Code is wrapped as `(async () => { CODE })()` and executed in a fresh
 * `vm.createContext` with SANDBOX_BUILTINS merged with the caller's context.
 *
 * @param code     - The JavaScript code to execute.
 * @param context  - Caller-provided helpers (e.g. call, dep, find, id).
 * @param options  - Optional filename for stack traces and timeout.
 * @returns The value returned by the code.
 */
export async function runSandboxed(
  code: string,
  context: Record<string, unknown>,
  options?: SandboxOptions,
): Promise<unknown> {
  requireNonEmpty(code, 'code');

  const sandbox = vm.createContext({
    ...SANDBOX_BUILTINS,
    ...context,
  });

  const script = new vm.Script(
    `(async () => { ${code} })()`,
    { filename: options?.filename ?? 'sandbox.js' },
  );

  return script.runInContext(sandbox, {
    timeout: options?.timeout,
  });
}

/**
 * Compile a parenthesized object expression in a sandboxed vm context.
 *
 * Used by ScriptableAbject to compile handler maps like:
 *   ({
 *     greet(msg) { return { greeting: 'Hello!' }; }
 *   })
 *
 * The source is wrapped as `(function(){ return SOURCE })()` and evaluated
 * in a fresh `vm.createContext`. The resulting object (handler map) is returned.
 *
 * @param source   - The parenthesized object expression source.
 * @param context  - Caller-provided helpers available during compilation.
 * @param options  - Optional filename for stack traces.
 * @returns The compiled handler map object.
 */
export function compileSandboxed(
  source: string,
  context: Record<string, unknown>,
  options?: SandboxOptions,
): Record<string, unknown> {
  requireNonEmpty(source, 'source');

  const sandbox = vm.createContext({
    ...SANDBOX_BUILTINS,
    ...context,
  });

  const script = new vm.Script(
    `(function(){ return ${source} })()`,
    { filename: options?.filename ?? 'compile-sandbox.js' },
  );

  const result = script.runInContext(sandbox, {
    timeout: options?.timeout,
  });

  contractRequire(
    typeof result === 'object' && result !== null,
    'Source must evaluate to a non-null object',
  );

  return result as Record<string, unknown>;
}
