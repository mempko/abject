/**
 * Handler map parser, reassembler, and syntax tokenizer.
 *
 * Parses a ScriptableAbject handler map source string `({ ... })` into
 * individual entries (properties, handlers, helpers), and reassembles
 * them back into a valid handler map string. Also provides a line-level
 * tokenizer for JavaScript syntax highlighting.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type EntryType = 'property' | 'handler' | 'helper';

export interface HandlerEntry {
  name: string;
  type: EntryType;
  /** The full text of this entry (e.g. `async show(msg) { ... }` or `_windowId: null`). */
  body: string;
}

export type TokenType =
  | 'keyword' | 'string' | 'number' | 'comment'
  | 'operator' | 'property' | 'function' | 'punctuation'
  | 'this' | 'normal';

export interface Token {
  text: string;
  type: TokenType;
}

// ── Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a handler map source `({ ... })` into individual entries.
 */
export function parseHandlerMap(source: string): HandlerEntry[] {
  const trimmed = source.trim();

  // Strip outer `({` and `})`
  let inner: string;
  if (trimmed.startsWith('({') && trimmed.endsWith('})')) {
    inner = trimmed.slice(2, -2);
  } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    inner = trimmed.slice(1, -1);
  } else {
    // Can't parse, return single entry
    return [{ name: '(source)', type: 'property', body: source }];
  }

  const entries: HandlerEntry[] = [];
  let i = 0;
  const len = inner.length;

  while (i < len) {
    // Skip whitespace and commas between entries
    while (i < len && /[\s,]/.test(inner[i])) i++;
    if (i >= len) break;

    // Find the entry name
    const nameStart = i;

    // Handle 'async' keyword before method name
    let isAsync = false;
    if (inner.slice(i, i + 5) === 'async' && /\s/.test(inner[i + 5])) {
      isAsync = true;
      i += 5;
      while (i < len && /\s/.test(inner[i])) i++;
    }

    // Read the name (identifier characters)
    const identStart = i;
    while (i < len && /[\w$]/.test(inner[i])) i++;
    const name = inner.slice(identStart, i);
    if (!name) {
      // Skip unknown character
      i++;
      continue;
    }

    // Skip whitespace after name
    while (i < len && /\s/.test(inner[i])) i++;

    // Determine if this is a method shorthand `name(` or a property `name:`
    if (inner[i] === '(') {
      // Method shorthand: name(...) { ... }
      // Find the full method body including parameter list and braces
      const methodStart = isAsync ? nameStart : identStart;
      i = skipBalanced(inner, i, '(', ')');
      // Skip whitespace between ) and {
      while (i < len && /\s/.test(inner[i])) i++;
      if (inner[i] === '{') {
        i = skipBalanced(inner, i, '{', '}');
      }
      const body = inner.slice(methodStart, i).trim();
      const type: EntryType = name.startsWith('_') ? 'helper' : 'handler';
      entries.push({ name, type, body });
    } else if (inner[i] === ':') {
      // Property: name: value
      i++; // skip ':'
      while (i < len && /\s/.test(inner[i])) i++;

      // Check if value is a function expression
      const valueStart = i;
      let isFunction = false;

      if (inner.slice(i, i + 8) === 'function' || inner.slice(i, i + 5) === 'async') {
        // function(...) { ... } or async function(...) { ... } or async (...) => { ... }
        isFunction = true;
      }

      // Read the value - skip balanced structures
      i = skipValue(inner, i);
      const value = inner.slice(valueStart, i).trim();
      const fullBody = `${name}: ${value}`;

      if (isFunction) {
        const type: EntryType = name.startsWith('_') ? 'helper' : 'handler';
        entries.push({ name, type, body: fullBody });
      } else {
        entries.push({ name, type: 'property', body: fullBody });
      }
    } else {
      // Unknown syntax - skip ahead
      i++;
    }
  }

  return entries;
}

/**
 * Skip a balanced pair of delimiters (parens, braces, brackets).
 * Handles strings and comments inside.
 */
function skipBalanced(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  const len = src.length;

  while (i < len) {
    const ch = src[i];
    if (ch === open) { depth++; i++; continue; }
    if (ch === close) { depth--; if (depth === 0) { i++; return i; } i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
    if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    i++;
  }
  return i;
}

/**
 * Skip a value expression at the top level (stops at comma or closing brace at depth 0).
 */
function skipValue(src: string, start: number): number {
  let depth = 0;
  let i = start;
  const len = src.length;

  while (i < len) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return i; // End of enclosing object
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === ',') return i;
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
    if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    i++;
  }
  return i;
}

function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) { i++; return i; }
    // Template literals can span lines
    i++;
  }
  return i;
}

function skipLineComment(src: string, start: number): number {
  let i = start + 2;
  while (i < src.length && src[i] !== '\n') i++;
  return i;
}

function skipBlockComment(src: string, start: number): number {
  let i = start + 2;
  while (i < src.length) {
    if (src[i] === '*' && src[i + 1] === '/') return i + 2;
    i++;
  }
  return i;
}

// ── Reassembler ────────────────────────────────────────────────────────

/**
 * Reassemble handler entries into a handler map source string.
 */
export function reassembleHandlerMap(entries: HandlerEntry[]): string {
  if (entries.length === 0) return '({})';
  const bodies = entries.map(e => '  ' + e.body);
  return '({\n' + bodies.join(',\n\n') + '\n})';
}

/**
 * Remove common leading whitespace from a multi-line string.
 */
export function dedent(text: string): string {
  const lines = text.split('\n');
  // Find minimum indentation (ignoring empty lines)
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === 0 || minIndent === Infinity) return text;
  return lines.map(line => line.slice(minIndent)).join('\n');
}

// ── Tokenizer ──────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  'async', 'await', 'const', 'let', 'var', 'if', 'else', 'for', 'while',
  'return', 'try', 'catch', 'throw', 'new', 'function', 'of', 'in',
  'switch', 'case', 'break', 'continue', 'default', 'do', 'typeof',
  'instanceof', 'void', 'delete', 'yield', 'class', 'extends', 'import',
  'export', 'from', 'static', 'get', 'set',
]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined']);

/**
 * Tokenize a single line of JavaScript for syntax highlighting.
 */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = line[i];

    // Line comment
    if (ch === '/' && line[i + 1] === '/') {
      tokens.push({ text: line.slice(i), type: 'comment' });
      return tokens;
    }

    // Strings
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      i++;
      while (i < len) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === ch) { i++; break; }
        i++;
      }
      tokens.push({ text: line.slice(start, i), type: 'string' });
      continue;
    }

    // Numbers
    if (/\d/.test(ch) || (ch === '.' && i + 1 < len && /\d/.test(line[i + 1]))) {
      const start = i;
      while (i < len && /[\d.xXa-fA-FeE_]/.test(line[i])) i++;
      tokens.push({ text: line.slice(start, i), type: 'number' });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      while (i < len && /[\w$]/.test(line[i])) i++;
      const word = line.slice(start, i);

      if (word === 'this') {
        tokens.push({ text: word, type: 'this' });
      } else if (KEYWORDS.has(word)) {
        tokens.push({ text: word, type: 'keyword' });
      } else if (LITERALS.has(word)) {
        tokens.push({ text: word, type: 'number' }); // color literals like numbers
      } else {
        // Check if it's a function call (word followed by `(`)
        let j = i;
        while (j < len && line[j] === ' ') j++;
        if (line[j] === '(') {
          tokens.push({ text: word, type: 'function' });
        }
        // Check if preceded by `.` (property access)
        else if (start > 0 && line[start - 1] === '.') {
          tokens.push({ text: word, type: 'property' });
        } else {
          tokens.push({ text: word, type: 'normal' });
        }
      }
      continue;
    }

    // Operators
    if ('=+-*/<>!&|?:%^~'.includes(ch)) {
      const start = i;
      // Consume multi-char operators
      i++;
      while (i < len && '=+-*/<>!&|?:%^~'.includes(line[i])) i++;
      tokens.push({ text: line.slice(start, i), type: 'operator' });
      continue;
    }

    // Punctuation
    if ('{}()[];:,.'.includes(ch)) {
      tokens.push({ text: ch, type: 'punctuation' });
      i++;
      continue;
    }

    // Whitespace - pass through as normal
    if (/\s/.test(ch)) {
      const start = i;
      while (i < len && /\s/.test(line[i])) i++;
      tokens.push({ text: line.slice(start, i), type: 'normal' });
      continue;
    }

    // Anything else
    tokens.push({ text: ch, type: 'normal' });
    i++;
  }

  return tokens;
}
