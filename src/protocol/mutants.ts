/**
 * Mutants -- deliberately broken copies of a candidate, used to test the
 * tests. If the fitness evidence cannot tell a mutant from the real thing,
 * the evidence is too weak to certify a heal.
 */
import * as acorn from 'acorn';

export interface Mutant { source: string; description: string; }

interface Site { start: number; end: number; replacement: string; description: string; }

const FLIP: Record<string, string> = {
  '<': '>=', '>': '<=', '<=': '>', '>=': '<', '===': '!==', '!==': '===', '==': '!=', '!=': '==',
};

/** Off-by-one, not negation: a candidate whose evidence cannot tell `<`
 *  from `<=` cannot certify a boundary. */
const BOUNDARY: Record<string, string> = {
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
};

/** Sign mistakes: pagination offsets, totals, deltas. `+` with a string
 *  literal or template operand is message formatting, not arithmetic --
 *  its mutants would measure error text, never behavior. */
const ARITH: Record<string, string> = { '+': '-', '-': '+' };

function looksLikeConcat(node: { operator: string; left: acorn.Node; right: acorn.Node }): boolean {
  if (node.operator !== '+') return false;
  const stringy = (n: acorn.Node): boolean =>
    n.type === 'TemplateLiteral'
    || (n.type === 'Literal' && typeof (n as unknown as { value?: unknown }).value === 'string');
  return stringy(node.left) || stringy(node.right);
}

const PARSE_OPTS: acorn.Options = { ecmaVersion: 'latest', allowAwaitOutsideFunction: true };

/** The dialects a candidate may be written in, most canonical first.
 *
 *  The invoker runs a candidate as `return (${source});` — so the house-style
 *  handler map is an EXPRESSION, and a bare-brace map (`{ async m(){} }`) is a
 *  valid object literal but NOT a valid block. Parsing only the statement-list
 *  dialect therefore found zero mutation sites in exactly the sources the gate
 *  exists to judge. Expression first, statement list second. */
const WRAPS: ReadonlyArray<{ prefix: string; suffix: string }> = [
  { prefix: '(', suffix: ')' },
  { prefix: 'async function __m__(args, http) {', suffix: '\n}' },
];

interface Parsed { ast: acorn.Node; offset: number; }

function parseCandidate(source: string): Parsed | null {
  for (const w of WRAPS) {
    try {
      return { ast: acorn.parse(`${w.prefix}${source}${w.suffix}`, PARSE_OPTS), offset: w.prefix.length };
    } catch { /* not this dialect — try the next */ }
  }
  return null;
}

/**
 * Mutants of `source`, or `null` when the source parses under NO supported
 * dialect. The distinction is load-bearing: an empty list means "nothing here
 * to break", while null means the gate could not read the candidate at all —
 * which must fail, not pass.
 */
export function generateMutants(source: string, max: number): Mutant[] | null {
  const parsed = parseCandidate(source);
  if (!parsed) return null;
  if (max <= 0) return [];
  const { ast, offset } = parsed;
  const sites: Site[] = [];

  (function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const n = node as acorn.Node & Record<string, unknown>;
    if (typeof n.type === 'string') {
      if (n.type === 'BinaryExpression') {
        const op = (n as unknown as { operator: string; left: acorn.Node; right: acorn.Node });
        for (const [table, verb] of [[FLIP, 'flip'], [BOUNDARY, 'boundary'], [ARITH, 'swap']] as const) {
          const to = table[op.operator];
          if (!to) continue;
          if (table === ARITH && looksLikeConcat(op)) continue;
          sites.push({
            start: op.left.end, end: op.right.start,
            replacement: ` ${to} `,
            description: `${verb} '${op.operator}' to '${to}'`,
          });
        }
      }
      if (n.type === 'CallExpression') {
        const callee = n.callee as (acorn.Node & { type: string; property?: { name?: string }; object?: acorn.Node });
        if (callee?.type === 'MemberExpression' && callee.property?.name === 'filter' && callee.object) {
          sites.push({
            start: (n as acorn.Node).start, end: (n as acorn.Node).end,
            replacement: source.slice(callee.object.start - offset, callee.object.end - offset),
            description: 'drop a .filter(...)',
          });
        }
      }
      if (n.type === 'ReturnStatement') {
        const arg = n.argument as acorn.Node & { type?: string } | null;
        if (arg && arg.type === 'ArrayExpression' && arg.end > arg.start + 2) {
          sites.push({ start: arg.start, end: arg.end, replacement: '[]',
            description: 'return [] instead of the array literal' });
        }
      }
      if (n.type === 'Property') {
        const key = n.key as acorn.Node & { type?: string; value?: unknown };
        if (key?.type === 'Literal' && typeof key.value === 'string') {
          sites.push({ start: key.start, end: key.end, replacement: `'__mutated__'`,
            description: `swap property key '${key.value}'` });
        }
      }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v);
    }
  })(ast);

  const seen = new Set<string>();
  const mutants: Mutant[] = [];
  for (const s of sites.sort((a, b) => a.start - b.start)) {
    const mutated = source.slice(0, s.start - offset) + s.replacement + source.slice(s.end - offset);
    if (mutated === source || seen.has(mutated)) continue;
    seen.add(mutated);
    mutants.push({ source: mutated, description: s.description });
    if (mutants.length >= max) break;
  }
  return mutants;
}
