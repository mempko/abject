/**
 * The shape of a pattern.
 *
 * Patterns are Alexander/Coplien pattern-language entries: a name, the
 * context that summons the pattern, the forces genuinely in tension, and the
 * resolution of those forces, linked to the patterns that follow from it.
 *
 * They are STORED AS JSON and RENDERED for people. Storing prose and
 * recovering the sections by matching headings was tried first and it lost:
 * patterns arrived written three different ways ('## Context', 'Context:',
 * '**Context:**'), the matcher understood one of them, and every update
 * rebuilt the entry from the sections it had failed to find. Five patterns
 * in one workspace were flattened to a single line that way, and the links
 * of fifteen more were invisible to the weave because they were written as a
 * '## Links' block instead of a 'Links:' line.
 *
 * With a structured body there is nothing to recognize: the LLM fills named
 * fields, links are an array of strings, and the prose form is generated,
 * never parsed. `parseLegacyPatternText` survives only to carry the old
 * entries across once.
 */

import { require as precondition, ensure } from './contracts.js';

/** Marks a stored body as structured. Bumped only if the shape changes. */
export const PATTERN_FORMAT = 1;

/** One section this vocabulary does not name, carried through verbatim. */
export interface PatternNote {
  heading: string;
  body: string;
}

/**
 * A pattern, in full. `context`, `forces`, `therefore` and `evidence` are
 * what make an entry a pattern rather than a tip, so they are required; the
 * rest sharpen it.
 */
export interface PatternBody {
  format: typeof PATTERN_FORMAT;
  name: string;
  /** Other names this pattern goes by, including ones merged into it. */
  aliases?: string;
  /** When the pattern applies. */
  context: string;
  /** The question the pattern answers. */
  problem?: string;
  /** The tensions that make the naive approach fail. */
  forces: string;
  /** The resolution of those forces. */
  therefore: string;
  /** Checkable obligations. */
  contract?: string;
  /** A worked example. */
  program?: string;
  /** What holds afterwards, and which patterns apply next. */
  resultingContext?: string;
  /** What following the pattern costs, and where it does not reach. */
  consequences?: string;
  /** How proven it is: Alexander's confidence, in prose. */
  evidence: string;
  /** The kinds of goal this pattern governs. */
  appliesTo?: string;
  /** Names of related patterns. Resolution is by normalized title. */
  links: string[];
  /** Sections carried over from a hand-written pattern, kept rather than dropped. */
  notes?: PatternNote[];
}

/** The prose sections, in the order a pattern reads. */
const SECTIONS: ReadonlyArray<{ key: keyof PatternBody; heading: string }> = [
  { key: 'aliases', heading: 'Aliases' },
  { key: 'context', heading: 'Context' },
  { key: 'problem', heading: 'Problem' },
  { key: 'forces', heading: 'Forces' },
  { key: 'therefore', heading: 'Therefore' },
  { key: 'contract', heading: 'Contract' },
  { key: 'program', heading: 'Program' },
  { key: 'resultingContext', heading: 'Resulting context' },
  { key: 'consequences', heading: 'Consequences' },
  { key: 'evidence', heading: 'Evidence' },
  { key: 'appliesTo', heading: 'Applies-to' },
];

/** Section keys addressable by save_pattern / update_pattern. */
export const PATTERN_FIELDS: ReadonlyArray<keyof PatternBody> = SECTIONS.map(s => s.key);

/** The fields without which an entry is a tip, not a pattern. */
const REQUIRED: ReadonlyArray<keyof PatternBody> = ['context', 'forces', 'therefore', 'evidence'];

/** Stands in for a section a pre-format pattern never recorded. */
const UNRECORDED = '(not recorded before this pattern was structured)';

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Build a valid body from loose fields, or explain what is missing.
 *
 * Returned rather than thrown: the caller is usually feeding an LLM's
 * output, and the message goes back to it as the correction.
 */
export function makePattern(
  fields: Partial<Record<keyof PatternBody, unknown>> & { name?: unknown },
): { ok: true; pattern: PatternBody } | { ok: false; error: string } {
  const name = text(fields.name);
  if (!name) return { ok: false, error: 'a pattern needs a "name"' };

  const missing = REQUIRED.filter(key => !text(fields[key]));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `pattern "${name}" is missing ${missing.join(', ')}; a pattern states the context it applies to, ` +
        'the forces in tension, what to do therefore, and the evidence behind it',
    };
  }

  const pattern: PatternBody = {
    format: PATTERN_FORMAT,
    name: name.toUpperCase(),
    context: text(fields.context)!,
    forces: text(fields.forces)!,
    therefore: text(fields.therefore)!,
    evidence: text(fields.evidence)!,
    links: normalizeLinks(fields.links),
  };
  for (const key of ['aliases', 'problem', 'contract', 'program', 'resultingContext', 'consequences', 'appliesTo'] as const) {
    const value = text(fields[key]);
    if (value) pattern[key] = value;
  }
  const notes = normalizeNotes(fields.notes);
  if (notes.length > 0) pattern.notes = notes;

  return { ok: true, pattern };
}

/** Link names, de-duplicated case-insensitively, order preserved. */
export function normalizeLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const raw of value) {
    const name = text(String(raw ?? '').replace(/->/g, ''));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(name);
  }
  return links;
}

function normalizeNotes(value: unknown): PatternNote[] {
  if (!Array.isArray(value)) return [];
  const notes: PatternNote[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const heading = text((raw as PatternNote).heading);
    const body = text((raw as PatternNote).body);
    if (heading && body) notes.push({ heading, body });
  }
  return notes;
}

/** Store form: compact JSON, one entry body. */
export function serializePattern(pattern: PatternBody): string {
  precondition(!!pattern.name, 'a pattern must have a name to serialize');
  return JSON.stringify(pattern);
}

/**
 * Read a stored pattern body, whatever era it comes from: structured JSON
 * for anything written since, and the old prose for anything written before.
 * Returns undefined only for content that is neither.
 */
export function readPattern(content: string, title?: string): PatternBody | undefined {
  const structured = readStructured(content);
  if (structured) return structured;
  return parseLegacyPatternText(content, title);
}

/** Parse the JSON form, or undefined if this is not a structured body. */
export function readStructured(content: string): PatternBody | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.format !== 'number') return undefined;

  const built = makePattern(candidate);
  return built.ok ? built.pattern : undefined;
}

/**
 * True when a pattern has been flattened.
 *
 * The old update path rebuilt entries out of the sections it had recognized,
 * so a pattern written in a shape it could not read came back with nothing
 * but its Evidence line. Conversion fills the absent sections with a marker,
 * which is what this looks for.
 */
export function isFlattenedPattern(pattern: PatternBody): boolean {
  return [pattern.context, pattern.forces, pattern.therefore]
    .every(section => section.startsWith(UNRECORDED));
}

/** True when this content is already stored in the structured form. */
export function isStructuredPattern(content: string): boolean {
  return readStructured(content) !== undefined;
}

/**
 * Render a pattern the way people read it: a markdown document with the
 * sections in order, closing with its links.
 *
 * This is the ONLY direction that runs at steady state. Nothing parses it
 * back, so it is free to be shaped for reading.
 */
export function renderPatternText(pattern: PatternBody): string {
  const blocks: string[] = [`# ${pattern.name}`];
  for (const { key, heading } of SECTIONS) {
    const body = text(pattern[key]);
    if (body) blocks.push(`## ${heading}\n${body}`);
  }
  for (const note of pattern.notes ?? []) {
    blocks.push(`## ${note.heading}\n${note.body}`);
  }
  if (pattern.links.length > 0) {
    blocks.push(`## Links\n${pattern.links.map(l => `-> ${l}`).join('\n')}`);
  }
  const rendered = blocks.join('\n\n');
  ensure(rendered.length > 0, 'a rendered pattern is never empty');
  return rendered;
}

/**
 * Everything in a pattern that is worth searching: the prose, without the
 * JSON punctuation. Full-text indexes run over this rather than the stored
 * body, so structuring patterns did not cost recall any accuracy.
 */
export function patternSearchText(pattern: PatternBody): string {
  const parts = [pattern.name];
  for (const { key } of SECTIONS) {
    const body = text(pattern[key]);
    if (body) parts.push(body);
  }
  for (const note of pattern.notes ?? []) parts.push(note.heading, note.body);
  parts.push(...pattern.links);
  return parts.join('\n');
}

// ─── One-time conversion of pre-structure patterns ──────────────────────

const HEADING_TO_FIELD = new Map<string, keyof PatternBody>(
  SECTIONS.map(s => [s.heading.toLowerCase(), s.key]),
);
// Headings the old corpus used that this vocabulary names differently.
const HEADING_ALIASES = new Map<string, keyof PatternBody>([
  ['solution', 'therefore'],
  ['resulting context', 'resultingContext'],
  ['consequences / caveats', 'consequences'],
  ['caveats', 'consequences'],
  ['known uses', 'evidence'],
  ['also known as', 'aliases'],
  ['applies to', 'appliesTo'],
  ['applies-to', 'appliesTo'],
]);

interface RawSection {
  heading: string;
  body: string;
}

/**
 * Recover a pattern from the prose it used to be stored as.
 *
 * Runs once per legacy entry, at load. It is deliberately generous about
 * shape, because the corpus it has to read was written by many different
 * agents over months: markdown headings at any level, bold labels, and
 * bare 'Heading:' lines all name a section here.
 *
 * Anything it cannot place is kept as a note. Nothing is dropped, because
 * dropping is the failure this whole change exists to end.
 */
export function parseLegacyPatternText(content: string, title?: string): PatternBody | undefined {
  const { preamble, sections } = splitLegacySections(content);

  const fields: Partial<Record<keyof PatternBody, unknown>> = {};
  const notes: PatternNote[] = [];
  const provenance: string[] = [];
  let links: string[] = [];

  for (const section of sections) {
    const key = section.heading.trim().toLowerCase().replace(/:$/, '');
    if (key === 'links') {
      links = links.concat(splitLinkNames(section.body));
      continue;
    }
    const field = HEADING_TO_FIELD.get(key) ?? HEADING_ALIASES.get(key);
    if (field && !section.body) continue;
    if (field && !fields[field]) {
      fields[field] = section.body;
      continue;
    }
    if (field) {
      // A second Context/Evidence block (merges produced these): append
      // rather than let the later one win or vanish.
      fields[field] = `${String(fields[field])}\n\n${section.body}`;
      continue;
    }
    if (section.body) {
      notes.push({ heading: section.heading, body: section.body });
    } else {
      // A heading with nothing under it carries its meaning in the heading.
      provenance.push(section.heading);
    }
  }
  if (provenance.length > 0) {
    notes.push({ heading: 'Provenance', body: provenance.join('\n') });
  }

  // A leading '# NAME' line is the pattern's own title, not content.
  const leftover = preamble.replace(/^\s*#\s+.*$/m, '').trim();
  if (leftover) notes.unshift({ heading: 'Notes', body: leftover });

  const name = title?.trim() || content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (!name) return undefined;

  // Legacy entries predate the requirement that a pattern state all four
  // essentials. Converting is not the moment to lose one, so anything
  // missing is filled with a marker the reviewer can see and repair.
  const built = makePattern({
    ...fields,
    name,
    context: fields.context ?? UNRECORDED,
    forces: fields.forces ?? UNRECORDED,
    therefore: fields.therefore ?? UNRECORDED,
    evidence: fields.evidence ?? 'unproven (predates evidence tracking)',
    links,
    notes,
  });
  return built.ok ? built.pattern : undefined;
}

/** Split legacy prose into a preamble and its labelled sections. */
function splitLegacySections(content: string): { preamble: string; sections: RawSection[] } {
  const known = new Set([...HEADING_TO_FIELD.keys(), ...HEADING_ALIASES.keys(), 'links']);
  const preamble: string[] = [];
  const sections: RawSection[] = [];
  let current: { heading: string; body: string[] } | undefined;

  const open = (heading: string, first: string) => {
    if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
    current = { heading: heading.trim().replace(/:$/, ''), body: first ? [first] : [] };
  };

  for (const line of content.split('\n')) {
    const md = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (md) {
      // A level-1 heading before any section is the pattern's name.
      if (md[1].length === 1 && !current && !known.has(md[2].trim().toLowerCase())) {
        preamble.push(line);
        continue;
      }
      open(md[2], '');
      continue;
    }
    const bold = /^\s*\*\*\s*([A-Za-z][\w \-/]{0,40}?)\s*:?\s*\*\*\s*:?\s*(.*)$/.exec(line);
    if (bold && known.has(bold[1].trim().toLowerCase())) {
      open(bold[1], bold[2]);
      continue;
    }
    const inline = /^\s*([A-Za-z][\w \-/]{0,40}?):\s*(.*)$/.exec(line);
    if (inline && known.has(inline[1].trim().toLowerCase())) {
      open(inline[1], inline[2]);
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });

  // Heading-only sections are KEPT. Merges left annotations like
  // '### Merged from: OTHER PATTERN (evidence preserved)' whose body is the
  // next labelled section, and dropping the empty one dropped the only
  // record that the merge ever happened.
  return { preamble: preamble.join('\n').trim(), sections };
}

/** Link names from a legacy Links section: comma-separated, arrow-prefixed, or both. */
function splitLinkNames(body: string): string[] {
  return body
    .split(/[,\n]/)
    .map(name => name.replace(/->/g, '').trim())
    .filter(name => name.length > 0);
}
