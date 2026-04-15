/**
 * Validation of MCP tool-call inputs against each tool's JSON Schema
 * (the `inputSchema` field returned by `tools/list`).
 *
 * MCP servers will accept malformed arguments and surface opaque errors
 * (e.g. "Email undefined not found" when `emailId` is missing). Validating
 * on the client side before `tools/call` turns those into deterministic,
 * actionable errors naming the tool and the offending parameter, so an
 * agent can correct itself on the next step instead of retrying blindly.
 *
 * Supports the JSON Schema dialects MCP tools commonly declare:
 *   - Default Ajv: draft-07 / draft-06 / draft-04 (and schemas with no
 *     `$schema` declaration, which is the typical MCP shape).
 *   - Ajv2019: draft-2019-09.
 *   - Ajv2020: draft-2020-12 (common in newer MCP servers).
 *
 * If a schema cannot be compiled by any supported dialect, it is logged at
 * warn level and skipped rather than crashing the call; silent skips are
 * reserved for genuinely unusable schemas only.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MCPInputValidation');

/** Error thrown when tool input fails JSON-Schema validation. */
export class MCPInputValidationError extends Error {
  readonly toolName: string;
  readonly issues: string[];

  constructor(toolName: string, issues: string[]) {
    super(`Invalid input for MCP tool "${toolName}": ${issues.join('; ')}`);
    this.name = 'MCPInputValidationError';
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** Cache of compiled validators keyed by schema identity. */
const validatorCache = new WeakMap<object, ValidateFunction | null>();

type Dialect = 'default' | '2019' | '2020';

let defaultAjv: Ajv | null = null;
let ajv2019: Ajv | null = null;
let ajv2020: Ajv | null = null;

function getAjv(dialect: Dialect): Ajv {
  // `strict: false` so unknown keywords in an otherwise-valid schema don't
  // throw; `allErrors: true` so we can report every missing/invalid param
  // from a single validation pass.
  const opts = { allErrors: true, strict: false } as const;
  if (dialect === '2020') {
    if (!ajv2020) ajv2020 = new Ajv2020(opts);
    return ajv2020;
  }
  if (dialect === '2019') {
    if (!ajv2019) ajv2019 = new Ajv2019(opts);
    return ajv2019;
  }
  if (!defaultAjv) defaultAjv = new Ajv(opts);
  return defaultAjv;
}

/**
 * Detect the JSON Schema dialect a tool's inputSchema declares via its
 * `$schema` keyword. MCP tools frequently omit `$schema`, in which case
 * 'default' (which handles draft-07 and older) is the right choice.
 */
function detectDialect(schema: Record<string, unknown>): Dialect {
  const decl = (schema as { $schema?: unknown }).$schema;
  if (typeof decl !== 'string') return 'default';
  if (decl.includes('2020-12')) return '2020';
  if (decl.includes('2019-09')) return '2019';
  return 'default';
}

/**
 * Compile a schema using the dialect it declares. Tries the declared
 * dialect first; if that fails (e.g. malformed schema, or a `$schema` URI
 * the primary instance doesn't recognize), falls back to the remaining
 * supported dialects before giving up. Returns null only when no dialect
 * can compile the schema.
 */
function compile(schema: Record<string, unknown>): ValidateFunction | null {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) return cached;

  const primary = detectDialect(schema);
  const order: Dialect[] = [primary];
  for (const d of ['default', '2020', '2019'] as const) {
    if (!order.includes(d)) order.push(d);
  }

  for (const dialect of order) {
    try {
      const fn = getAjv(dialect).compile(schema);
      validatorCache.set(schema, fn);
      return fn;
    } catch (err) {
      log.info(`compile failed with ${dialect} dialect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Last resort: an unrecognized `$schema` URI can prevent every instance
  // from compiling even when the schema body is otherwise valid. Retry once
  // with `$schema` stripped against the default (draft-07) Ajv.
  if (typeof (schema as { $schema?: unknown }).$schema === 'string') {
    const { $schema: _drop, ...rest } = schema as { $schema?: unknown } & Record<string, unknown>;
    void _drop;
    try {
      const fn = getAjv('default').compile(rest);
      log.info(
        `compiled tool inputSchema after stripping unrecognized $schema=${JSON.stringify((schema as { $schema?: unknown }).$schema)}`,
      );
      validatorCache.set(schema, fn);
      return fn;
    } catch (err) {
      log.info(`compile failed after stripping $schema: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.warn(
    `Unable to compile tool inputSchema under any supported dialect; ` +
      `validation will be skipped. Declared $schema=${JSON.stringify((schema as { $schema?: unknown }).$schema ?? null)}`,
  );
  validatorCache.set(schema, null);
  return null;
}

/**
 * Format a single Ajv error into a human/agent-friendly message.
 * Emphasizes the parameter name so the agent knows what to fix.
 */
function formatAjvError(err: import('ajv').ErrorObject): string {
  if (err.keyword === 'required') {
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    return missing ? `missing required parameter "${missing}"` : `missing required parameter`;
  }
  if (err.keyword === 'type') {
    const param = err.instancePath.replace(/^\//, '') || '(root)';
    const expected = (err.params as { type?: string | string[] }).type;
    const expectedStr = Array.isArray(expected) ? expected.join('|') : (expected ?? 'unknown');
    return `parameter "${param}" must be ${expectedStr}`;
  }
  if (err.keyword === 'enum') {
    const param = err.instancePath.replace(/^\//, '') || '(root)';
    const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    return `parameter "${param}" must be one of ${allowed.map(v => JSON.stringify(v)).join(', ')}`;
  }
  if (err.keyword === 'additionalProperties') {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return extra ? `unknown parameter "${extra}"` : `unknown parameter`;
  }
  const path = err.instancePath || '(root)';
  return `${path} ${err.message ?? 'is invalid'}`;
}

/**
 * Validate `input` against the given tool's JSON `inputSchema`.
 * Throws `MCPInputValidationError` listing each problem (required, type,
 * enum, etc.) if the input is invalid. Silently succeeds when the schema
 * is absent or genuinely uncompilable (after both dialects fail — logged).
 */
export function validateMCPToolInput(
  toolName: string,
  inputSchema: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): void {
  if (!inputSchema || typeof inputSchema !== 'object') return;

  const validate = compile(inputSchema);
  if (!validate) return;

  if (validate(input)) return;

  const issues = (validate.errors ?? []).map(formatAjvError);
  const unique = Array.from(new Set(issues));
  throw new MCPInputValidationError(toolName, unique.length > 0 ? unique : ['invalid input']);
}
