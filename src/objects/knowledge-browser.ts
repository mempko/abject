/**
 * KnowledgeBrowser -- UI for browsing, searching, and managing the
 * agent knowledge base.
 *
 * Split-pane layout: search input + list on the left, detail view on the
 * right. Tab bar for type filtering (including the workspace's pattern
 * language), toolbar row with a 'Show archived' toggle and a Curate button
 * (asks the reviewer to run a background curation pass). Search triggers
 * FTS5 full-text recall on the KnowledgeBase (searches content, not just
 * titles).
 *
 * Pattern entries get link navigation: the detail pane renders the
 * pattern's links as clickable chips (click opens
 * the linked pattern), names with no written pattern yet as dimmed
 * "unwritten" labels, and a reverse "Linked from" row of the patterns
 * whose Links name this one.
 *
 * On the Patterns tab a map sits beside the list: the pattern language as a
 * 3D graph (the nodeGraph widget), one node per pattern and a see-through
 * node per unwritten link name. Selection syncs both ways: a click on the
 * map opens the pattern in the detail pane and the list, and choosing a
 * pattern in the list or through a link chip selects it on the map. A
 * newly woven pattern arrives as a flow of living light along its links.
 *
 * The Maps tab reads the workspace's DocumentMap instead of the
 * KnowledgeBase: the list holds every page of every map (each map's index
 * first), the search field searches pages, and a selected page shows its
 * sources, flags and body with the same link chips patterns use. The graph
 * pane draws the selected page's map (pages, their `[[links]]`, and
 * see-through nodes for pages not written yet). Pages are written by agents
 * or edited in Files, so the forget, restore and curate controls are hidden
 * there. DocumentMap's `pageChanged` and `mapsChanged` events reload it.
 *
 * The Learning tab is a read-only report over GoalManager's learning funnel
 * (`getLearningFunnel`): how many actions stated a prediction and named the
 * belief behind it, how the reviewer judged them and what it blamed for the
 * misses, and how many of the resulting updates reached the world model.
 * Above it sits the learning curve (`getLearningCurve`): a week-by-week
 * table of predictions, surprises, questions and the person's reactions,
 * how often predictions proved wrong by how many times the same kind of
 * action had come up before (learning is being surprised less in repeated
 * contexts), and the kinds of action judged most often. It replaces the list
 * and detail panes while active, loads when first shown, and re-reads on
 * Refresh. An entry's detail shows its test record (held n of m, flagged).
 *
 * Forgetting a live entry (it is archived) and restoring an archived one are
 * undoable from the window: the browser keeps one history of what was done
 * through it (in memory) and undoes with the opposite `archive` message.
 * Deleting an archived entry for good stays final, behind its confirm: its
 * tombstone has already gone to peers.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { require as precondition, ensure } from '../core/contracts.js';
import { UndoHistory, UndoRefused, UNDO_EVENTS, undoMethods, type UndoAction } from '../core/undo.js';
import { emptyStateMarkdown, emptyStateStyle, hintStyle, sectionHeaderStyle, sectionHeaderText } from './ui-kit.js';
import { readPattern, readStructured, renderPatternText } from '../core/pattern.js';
import type { KnowledgeEntry, KnowledgeType } from '../core/knowledge.js';
import { INDEX_SLUG, linkKey, slugOf } from '../core/map-page.js';
import { OCCURRENCE_BUCKETS, NEGATIVE_REACTIONS, type OccurrenceBucket } from '../core/surprise.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('KnowledgeBrowser');

const KNOWLEDGE_BROWSER_INTERFACE: InterfaceId = 'abjects:knowledge-browser';

const WIN_W = 900;
const WIN_H = 540;
/** Minimum gap between arrival flashes, so a curation pass reads as one signal. */
const ARRIVAL_FLASH_GAP_MS = 1500;

/** Map node id prefix for unwritten (ghost) patterns: a dangling link name. */
const GHOST_PREFIX = 'unwritten:';

/**
 * Vector icon names for knowledge types. ListWidget renders these at the
 * row leading edge (via ListItem.iconName); colors come from the theme.
 */
const TAB_LABELS = ['All', 'Patterns', 'Learned', 'Facts', 'Insights', 'References', 'Maps', 'Learning'];
const TAB_TYPES: (KnowledgeType | undefined)[] = [undefined, 'pattern', 'learned', 'fact', 'insight', 'reference'];
/** The Maps tab: DocumentMap's pages, not a KnowledgeBase type filter. */
const MAPS_TAB = TAB_LABELS.indexOf('Maps');
/** The Learning tab: a report over GoalManager's learning funnel, not a type filter. */
const LEARNING_TAB = TAB_LABELS.indexOf('Learning');

/** Map node id prefix for a written map page (the rest is its slug). */
const PAGE_PREFIX = 'page:';
/** Most pages the Maps tab's search lists (DocumentMap caps a search at 20). */
const MAP_SEARCH_LIMIT = 20;
const MAPS_EMPTY_TITLE = 'No maps yet';
const MAPS_EMPTY_BODY =
  'A map is a short guide to a collection of documents, with a page per subject and links between them. '
  + 'Ask in Chat to map a folder, for example "map the documents in /uploads/contracts". '
  + "A project's map appears here after an agent has worked in it.";

/** One page of a map as the Maps tab lists it (from DocumentMap `getMap`). */
interface MapPageRow {
  map: string;
  mapName: string;
  mapKind: string;
  title: string;
  slug: string;
  revision: number;
  writer: string;
  updatedAt: number;
  sources: number;
  flagged: boolean;
  editedInFiles: boolean;
}

/** DocumentMap's `getMap` reply, as far as the browser reads it. */
interface MapDetail {
  id: string;
  kind: string;
  name: string;
  pages?: Array<{
    title: string; slug: string; aliases?: string[]; revision?: number; writer?: string; updatedAt?: number;
    sources?: number; flagged?: boolean; editedInFiles?: boolean;
  }>;
}

/** DocumentMap's `readPage` reply for a page it found. */
interface MapPageView {
  map: string;
  title: string;
  slug: string;
  revision: number;
  writer: string;
  updatedAt: number;
  flagged: boolean;
  editedInFiles: boolean;
  path: string;
  body: string;
  sources: Array<{ path: string; fp?: string }>;
  flags: Array<{ reason: string; by: string; at: number }>;
  sourceRoot: { kind: string; root: string };
  links: string[];
  unwrittenLinks: string[];
  linkedFrom: string[];
}

/** DocumentMap's `lint` reply, as far as the index summary reads it. */
interface MapLint {
  unwritten?: unknown[];
  broken?: unknown[];
  orphans?: unknown[];
  uncited?: unknown[];
  flagged?: unknown[];
  editedInFiles?: unknown[];
  size?: { bloated?: boolean };
}

/** Where a link chip leads: a KnowledgeBase entry, or a page of a map. */
type LinkTarget =
  | { kind: 'entry'; entry: KnowledgeEntry }
  | { kind: 'page'; map: string; page: string };

/** One node the graph pane draws, with the link names it uses (resolved or not). */
interface GraphItem { id: string; label: string; size: number; links: string[] }

/** What the graph pane draws: its items, how a link name finds an item, and what to select. */
interface GraphSource {
  title: string;
  emptyText: string;
  items: GraphItem[];
  resolve: (name: string) => string | undefined;
  selectedId?: string;
}

/** "1 page" / "3 pages". */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A map's lint report in a few plain words, for its index page's meta line. */
function lintSummary(lint: MapLint): string {
  const n = (v: unknown[] | undefined) => (Array.isArray(v) ? v.length : 0);
  const parts: string[] = [];
  if (n(lint.unwritten)) parts.push(plural(n(lint.unwritten), 'page linked but not written yet', 'pages linked but not written yet'));
  if (n(lint.broken)) parts.push(plural(n(lint.broken), 'link to an archived page', 'links to archived pages'));
  if (n(lint.orphans)) parts.push(plural(n(lint.orphans), 'page nothing links to', 'pages nothing links to'));
  if (n(lint.uncited)) parts.push(plural(n(lint.uncited), 'page citing no sources', 'pages citing no sources'));
  if (n(lint.flagged)) parts.push(plural(n(lint.flagged), 'flagged page', 'flagged pages'));
  if (n(lint.editedInFiles)) parts.push(plural(n(lint.editedInFiles), 'page edited in Files', 'pages edited in Files'));
  if (lint.size?.bloated) parts.push('large next to its sources');
  return parts.length > 0 ? parts.join(' · ') : 'no problems found';
}

/** Height of one Learning report row (fixed: a scrolling pane culls rows with no height). */
const REPORT_ROW_H = 22;
const REPORT_BAR_W = 160;
const REPORT_VALUE_W = 140;
const LEARNING_INTRO =
  'Agents predict before they act. The reviewer judges each prediction, finds the belief that failed, and updates what this workspace knows.';
const LEARNING_UNAVAILABLE = 'The learning report is unavailable: the goal manager for this workspace did not answer.';

/** GoalManager's `getLearningFunnel` reply, normalized. */
interface LearningFunnel {
  scope: string;
  predictions: { observed: number; withExpectation: number; namingBelief: number; declaringPattern: number };
  judgments: { total: number; byVerdict: Record<string, number>; missesByBlame: Record<string, number> };
  updates: { byState: Record<string, number>; openReasons: Array<{ reason: string; n: number }> };
  lifetime: { applied: number; abandoned: number };
}

/** One column of a report table, as the table widget takes it. */
interface ReportColumn { key: string; label: string; width?: number; align?: 'left' | 'right' }

/** One row of the Learning report, top to bottom. */
type ReportRow =
  | { kind: 'heading'; text: string }
  | { kind: 'note'; text: string; lines?: number }
  | { kind: 'stat'; label: string; value: string; ratio?: number }
  | { kind: 'table'; columns: ReportColumn[]; rows: Array<Record<string, string>> };

/** Plain names for the reviewer's verdicts, blame sources and update states (in display order). */
const VERDICT_LABELS: Record<string, string> = {
  supported: 'Held up',
  contradicted: 'Proved wrong',
  unresolved: 'Could not tell',
};
const BLAME_LABELS: Record<string, string> = {
  prior: "The agent's own assumption",
  entry: 'A knowledge entry',
  pattern: 'A pattern',
  link: 'A link between patterns',
  world: 'The world changed',
  runtime: 'A system fault, not a belief',
  none: 'Nothing named',
};
const STATE_LABELS: Record<string, string> = {
  applied: 'Applied to the world model',
  proposed: 'Proposed, not applied yet',
  needs_repair: 'Need repair first',
  waiting: 'Waiting',
  abandoned: 'Abandoned',
};

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (count(n) > 0) out[k] = count(n);
  return out;
}

/** Validate and normalize a `getLearningFunnel` reply; throws on a shape it does not recognize. */
function readFunnel(raw: unknown): LearningFunnel {
  type Part = Record<string, unknown> | undefined;
  const r = (raw ?? {}) as { scope?: unknown; predictions?: Part; judgments?: Part; updates?: Part; lifetime?: Part };
  if (!r.predictions || !r.judgments || !r.updates) throw new Error('Unexpected learning funnel reply');
  const reasons = Array.isArray(r.updates.openReasons) ? r.updates.openReasons as Array<{ reason?: unknown; n?: unknown }> : [];
  return {
    scope: typeof r.scope === 'string' && r.scope ? r.scope : 'goals in memory',
    predictions: {
      observed: count(r.predictions.observed),
      withExpectation: count(r.predictions.withExpectation),
      namingBelief: count(r.predictions.namingBelief),
      declaringPattern: count(r.predictions.declaringPattern),
    },
    judgments: {
      total: count(r.judgments.total),
      byVerdict: counts(r.judgments.byVerdict),
      missesByBlame: counts(r.judgments.missesByBlame),
    },
    updates: {
      byState: counts(r.updates.byState),
      openReasons: reasons.map(x => ({ reason: String(x?.reason ?? ''), n: count(x?.n) })).filter(x => x.n > 0),
    },
    lifetime: { applied: count(r.lifetime?.applied), abandoned: count(r.lifetime?.abandoned) },
  };
}

/** Keys of a count map in the order of its label table, unknown keys last. */
function ordered(map: Record<string, number>, labels: Record<string, string>): string[] {
  return [...Object.keys(labels).filter(k => k in map), ...Object.keys(map).filter(k => !(k in labels))];
}

/** "n of total (pct%)" with a bar ratio, or the bare count when there is nothing to divide by. */
function share(n: number, of: number): { value: string; ratio?: number } {
  precondition(n >= 0 && of >= 0, 'share takes non-negative counts');
  if (of === 0) return { value: String(n) };
  return { value: `${n} of ${of}  (${Math.round((n / of) * 100)}%)`, ratio: Math.min(1, n / of) };
}

/** The funnel as report rows: predictions, judgments, updates, all-time totals. */
function funnelRows(f: LearningFunnel): ReportRow[] {
  const p = f.predictions, j = f.judgments, u = f.updates;
  const stat = (label: string, s: { value: string; ratio?: number }): ReportRow => ({ kind: 'stat', label, ...s });
  const rows: ReportRow[] = [];
  const effects = Object.values(u.byState).reduce((a, b) => a + b, 0);
  if (p.observed === 0 && j.total === 0 && effects === 0) {
    rows.push({ kind: 'note', text: 'Nothing to measure yet. These counts fill in as agents work on goals.' });
  }

  rows.push({ kind: 'heading', text: 'Predictions' });
  rows.push(stat('Actions agents recorded', { value: String(p.observed) }));
  rows.push(stat('Said what they expected to happen', share(p.withExpectation, p.observed)));
  rows.push(stat('Named the knowledge they relied on', share(p.namingBelief, p.withExpectation)));
  rows.push(stat('Named a pattern they followed', share(p.declaringPattern, p.withExpectation)));

  rows.push({ kind: 'heading', text: 'Judgments' });
  rows.push(stat('Actions the reviewer judged', share(j.total, p.observed)));
  for (const v of ordered(j.byVerdict, VERDICT_LABELS)) {
    rows.push(stat(VERDICT_LABELS[v] ?? v, share(j.byVerdict[v], j.total)));
  }
  const misses = Object.values(j.missesByBlame).reduce((a, b) => a + b, 0);
  if (misses > 0) {
    rows.push({ kind: 'note', text: 'When a prediction proved wrong, the reviewer blamed:' });
    for (const b of ordered(j.missesByBlame, BLAME_LABELS)) {
      rows.push(stat(BLAME_LABELS[b] ?? b, share(j.missesByBlame[b], misses)));
    }
  }

  rows.push({ kind: 'heading', text: 'Updates to the world model' });
  if (effects === 0) rows.push({ kind: 'note', text: 'No updates proposed yet.' });
  for (const s of ordered(u.byState, STATE_LABELS)) {
    rows.push(stat(STATE_LABELS[s] ?? s, share(u.byState[s], effects)));
  }
  if (u.openReasons.length > 0) {
    rows.push({ kind: 'note', text: 'Why open updates have not landed:' });
    for (const r of u.openReasons.slice(0, 5)) {
      // GoalManager reports an open update with no error yet as '(none)'.
      const text = !r.reason || r.reason === '(none)' ? 'No problem recorded yet' : r.reason;
      rows.push(stat(text.length > 90 ? `${text.slice(0, 87)}...` : text, { value: String(r.n) }));
    }
  }

  rows.push({ kind: 'heading', text: 'All time' });
  rows.push(stat('Updates applied', { value: String(f.lifetime.applied) }));
  rows.push(stat('Updates abandoned', { value: String(f.lifetime.abandoned) }));
  ensure(rows.length > 0, 'the funnel report has rows');
  return rows;
}

// ── The learning curve (GoalManager `getLearningCurve`) ─────────────────

/** Weeks of history the Learning tab asks for. */
const CURVE_WEEKS = 12;
/** Kinds of action listed under the curve, most judged first. */
const TOP_CONTEXTS = 8;
const TABLE_HEADER_H = 28;
const TABLE_ROW_H = 24;

/** One week of `getLearningCurve`, normalized to the counts the table shows. */
interface WeekRow {
  week: string;
  actions: number;
  expect: number;
  basis: number;
  judged: number;
  supported: number;
  contradicted: number;
  unresolved: number;
  toBelief: number;
  brier: number;
  scored: number;
  asked: number;
  corrected: number;
  reactions: Record<string, number>;
}

/** GoalManager's `getLearningCurve` reply, normalized. */
interface LearningCurve {
  scope: string;
  weeks: WeekRow[];
  curve: Record<OccurrenceBucket, { judged: number; contradicted: number }>;
  contexts: Array<{ key: string; judged: number; contradicted: number }>;
}

/** Plain names for the occurrence buckets: how many times the same kind of action had come up. */
const BUCKET_LABELS: Record<OccurrenceBucket, string> = {
  '1': 'The first time',
  '2-3': 'The 2nd or 3rd time',
  '4-7': '4 to 7 times in',
  '8-15': '8 to 15 times in',
  '16+': '16 times or more',
};

const WEEK_COLUMNS: ReportColumn[] = [
  { key: 'week', label: 'Week', width: 64 },
  { key: 'actions', label: 'Actions', align: 'right' },
  { key: 'predicted', label: 'Predicted', align: 'right' },
  { key: 'cited', label: 'Named why', align: 'right' },
  { key: 'judged', label: 'Judged', align: 'right' },
  { key: 'surprise', label: 'Surprised', align: 'right' },
  { key: 'unclear', label: 'Unclear', align: 'right' },
  { key: 'blamed', label: 'Belief blamed', align: 'right' },
  { key: 'error', label: 'Off by', align: 'right' },
  { key: 'asked', label: 'Asked you', align: 'right' },
  { key: 'corrected', label: 'You corrected', align: 'right' },
  { key: 'reactions', label: 'Unhappy / happy', align: 'right' },
];

const WEEK_COLUMNS_NOTE =
  'Predicted: actions where the agent said what it expected. Named why: predictions that named the knowledge behind them. '
  + 'Surprised: judged predictions that proved wrong. Unclear: judgments that could not tell. '
  + 'Belief blamed: wrong predictions traced to something the system believed, of all wrong ones. '
  + 'Off by: how far stated confidence was from what happened (0 is perfect, lower is better). '
  + 'Asked you: questions put to you about what you wanted; You corrected: answers that changed the guess. '
  + 'Unhappy / happy: how you reacted to results.';

function pct(n: number, of: number): string {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : '-';
}

/** Validate and normalize a `getLearningCurve` reply; throws on a shape it does not recognize. */
function readCurve(raw: unknown): LearningCurve {
  const r = (raw ?? {}) as { scope?: unknown; weeks?: unknown; curve?: unknown; contexts?: unknown };
  if (!Array.isArray(r.weeks)) throw new Error('Unexpected learning curve reply');
  const weeks: WeekRow[] = (r.weeks as Array<Record<string, unknown>>)
    .filter(w => w && typeof w.week === 'string')
    .map(w => ({
      week: w.week as string,
      actions: count(w.actions), expect: count(w.expect), basis: count(w.basis),
      judged: count(w.judged), supported: count(w.supported), contradicted: count(w.contradicted),
      unresolved: count(w.unresolved), toBelief: count(w.toBelief),
      brier: typeof w.brier === 'number' && Number.isFinite(w.brier) && w.brier > 0 ? w.brier : 0,
      scored: count(w.scored), asked: count(w.asked), corrected: count(w.corrected),
      reactions: counts(w.reactions),
    }))
    .sort((a, b) => b.week.localeCompare(a.week));
  const rawCurve = (r.curve ?? {}) as Record<string, { judged?: unknown; contradicted?: unknown } | undefined>;
  const curve = Object.fromEntries(OCCURRENCE_BUCKETS.map(b => [b, {
    judged: count(rawCurve[b]?.judged), contradicted: count(rawCurve[b]?.contradicted),
  }])) as LearningCurve['curve'];
  const contexts = (Array.isArray(r.contexts) ? r.contexts as Array<Record<string, unknown>> : [])
    .filter(c => c && typeof c.key === 'string')
    .map(c => ({ key: c.key as string, judged: count(c.judged), contradicted: count(c.contradicted) }))
    .filter(c => c.judged > 0)
    .sort((a, b) => b.judged - a.judged)
    .slice(0, TOP_CONTEXTS);
  return { scope: typeof r.scope === 'string' && r.scope ? r.scope : 'all recorded', weeks, curve, contexts };
}

/** A week's Monday as "Oct 26". */
function weekLabel(week: string): string {
  const d = new Date(`${week}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? week : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A context key (`agent|action|target|method`) as words: "Agent: call Target.method". */
function contextLabel(key: string): string {
  const [agent, action, target, method] = key.split('|');
  const on = [target, method].filter(Boolean).join('.');
  const text = `${agent && agent !== '?' ? `${agent}: ` : ''}${action ?? key}${on ? ` ${on}` : ''}`;
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

/** The learning curve as report rows: the weekly table, surprise by repetition, the busiest contexts. */
function curveRows(c: LearningCurve): ReportRow[] {
  const rows: ReportRow[] = [];
  rows.push({ kind: 'heading', text: 'Week by week' });
  if (c.weeks.length === 0) {
    rows.push({ kind: 'note', text: 'No weeks recorded yet. The table fills in as agents work on goals.' });
  } else {
    const negative = NEGATIVE_REACTIONS as readonly string[];
    rows.push({
      kind: 'table', columns: WEEK_COLUMNS,
      rows: c.weeks.map(w => {
        const unhappy = Object.entries(w.reactions).filter(([k]) => negative.includes(k)).reduce((a, [, n]) => a + n, 0);
        return {
          week: weekLabel(w.week),
          actions: String(w.actions),
          predicted: pct(w.expect, w.actions),
          cited: pct(w.basis, w.expect),
          judged: String(w.judged),
          surprise: pct(w.contradicted, w.supported + w.contradicted),
          unclear: pct(w.unresolved, w.judged),
          blamed: w.contradicted > 0 ? `${w.toBelief} of ${w.contradicted}` : '-',
          error: w.scored > 0 ? (w.brier / w.scored).toFixed(2) : '-',
          asked: String(w.asked),
          corrected: String(w.corrected),
          reactions: `${unhappy} / ${w.reactions.satisfied ?? 0}`,
        };
      }),
    });
    rows.push({ kind: 'note', text: WEEK_COLUMNS_NOTE, lines: 5 });
  }

  rows.push({ kind: 'heading', text: 'Surprised less with practice?' });
  rows.push({ kind: 'note', text: 'Predictions that proved wrong, by how many times the agent had done the same kind of action before. Learning shows as shorter bars further down.', lines: 2 });
  for (const b of OCCURRENCE_BUCKETS) {
    const { judged, contradicted } = c.curve[b];
    rows.push({ kind: 'stat', label: BUCKET_LABELS[b], ...share(contradicted, judged) });
  }

  if (c.contexts.length > 0) {
    rows.push({ kind: 'heading', text: 'Most frequent kinds of action' });
    rows.push({ kind: 'note', text: 'Wrong predictions out of those judged, for the kinds of action judged most often.' });
    for (const ctx of c.contexts) rows.push({ kind: 'stat', label: contextLabel(ctx.key), ...share(ctx.contradicted, ctx.judged) });
  }
  ensure(rows.length > 0, 'the curve report has rows');
  return rows;
}

/** An entry's test record in a few words, for the detail pane's metadata line. */
function evidenceText(entry: KnowledgeEntry): string {
  const ev = entry.evidence;
  const tests = ev ? count(ev.held) + count(ev.missed) : 0;
  if (!ev || tests === 0) return 'Untested';
  const last = ev.lastTestedAt ? `, last ${new Date(ev.lastTestedAt).toLocaleDateString()}` : '';
  return `Held ${count(ev.held)} of ${tests}${last}${ev.flagged ? '  |  Flagged: wrong more often than right' : ''}`;
}

export class KnowledgeBrowser extends Abject {
  private knowledgeBaseId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private splitPaneId?: AbjectId;
  private searchInputId?: AbjectId;
  private listWidgetId?: AbjectId;
  private leftLayoutId?: AbjectId;
  private detailLayoutId?: AbjectId;
  private titleLabelId?: AbjectId;
  private typeLabelId?: AbjectId;
  private tagsLabelId?: AbjectId;
  private metaLabelId?: AbjectId;
  private contentLabelId?: AbjectId;
  private deleteBtnId?: AbjectId;
  private restoreBtnId?: AbjectId;
  private buttonRowId?: AbjectId;
  private emptyLabelId?: AbjectId;
  private dividerId?: AbjectId;
  /** Empty-state label sharing the list's slot; shown when the list is empty. */
  private listEmptyId?: AbjectId;
  private listEmptyShown?: boolean;
  private archivedToggleId?: AbjectId;
  private curateBtnId?: AbjectId;
  private toolbarRowId?: AbjectId;

  // Learning tab: built on first show, rows rebuilt on every load.
  private goalManagerId?: AbjectId;
  private learningPaneId?: AbjectId;
  private learningRefreshId?: AbjectId;
  private learningStatusId?: AbjectId;
  /** The pane's dynamic rows (headings, notes, stat rows), removed and destroyed on reload. */
  private learningRowIds: AbjectId[] = [];
  /** Building the pane, shared so a doubled tab event builds it once. */
  private learningPaneReady?: Promise<void>;
  private learningShown = false;
  private learningLoaded = false;
  private learningLoading = false;

  /** This peer's id, for telling locally authored entries from synced ones. */
  private localPeerId = '';

  private innerSplitId?: AbjectId;
  /** Pattern language map (a nodeGraph widget), shown on the Patterns tab. */
  private graphId?: AbjectId;
  /** Pattern ids on the map, with each pattern's outgoing link targets (map node ids). */
  private graphLinks = new Map<string, string[]>();

  private linksRowId?: AbjectId;
  private linkedFromRowId?: AbjectId;
  /** Dynamic chips currently in the link rows, with the row each lives in. */
  private linkRowWidgets: Array<{ rowId: AbjectId; widgetId: AbjectId }> = [];
  /** Link-navigation buttons mapped to the pattern entry or map page they open. */
  private linkButtons: Map<AbjectId, LinkTarget> = new Map();
  /** Whether the graph pane is open (the Patterns tab, or the Maps tab once a page is chosen). */
  private graphShown = false;

  // Maps tab: pages of every map, read from DocumentMap.
  private documentMapId?: AbjectId;
  private documentMapSubscribed = false;
  /** Every page of every map, by map then index first. */
  private mapRows: MapPageRow[] = [];
  /** The rows the list shows (all of them, or the search's hits). */
  private filteredMapRows: MapPageRow[] = [];
  /** DocumentMap answered the last load. */
  private mapsAvailable = true;
  /** Map reloads running, by name, each noting whether another was asked for meanwhile. */
  private mapReloads = new Map<string, { again: boolean }>();
  /** The page shown in the detail pane on the Maps tab. */
  private selectedPage?: { map: string; slug: string; title: string };
  /** The map the graph pane draws on the Maps tab. */
  private graphMapId?: string;

  private entries: KnowledgeEntry[] = [];
  private filteredEntries: KnowledgeEntry[] = [];
  private selectedId?: string;
  private activeTab = 0;
  private searchQuery = '';
  private showArchived = false;
  /** When the last new-entry flash played. */
  private lastArrivalFlashAt = 0;
  /**
   * Archivings and restorings made through this window, for undo. Each step
   * holds the archived state it left the entry in.
   */
  private archiveSteps = new UndoHistory<{ id: string; title: string; archived: boolean }>({ maxSteps: 50, mergeMs: 0 });

  constructor() {
    super({
      manifest: {
        name: 'KnowledgeBrowser',
        description:
          'Browse, search, and manage the agent knowledge base. View learned lessons, discovered facts, agent insights, reference entries, and the workspace pattern language (with clickable links between patterns).',
        version: '1.0.0',
        interface: {
          id: KNOWLEDGE_BROWSER_INTERFACE,
          name: 'KnowledgeBrowser',
          description: 'Knowledge base browser UI',
          methods: [
            {
              name: 'show',
              description: 'Show the knowledge browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the knowledge browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            ...undoMethods('the last entry forgotten (archived) or restored in this window'),
          ],
          events: [...UNDO_EVENTS],
        },
        tags: ['system', 'ui'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.knowledgeBaseId = await this.discoverDep('KnowledgeBase') ?? undefined;
    this.documentMapId = await this.discoverDep('DocumentMap').catch(() => null) ?? undefined;

    // Peer id, so entries synced from other peers can be attributed and their
    // edit controls withheld. Falls back to this object's id until Identity
    // answers, which reads every entry as local -- the pre-sharing behaviour.
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.localPeerId = identity.peerId;
      } catch { /* Identity may not be ready */ }
    }
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('undo', async () => this.undoArchive('undo'));
    this.on('redo', async () => this.undoArchive('redo'));
    this.on('getUndoState', async () => this.archiveSteps.state());
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Window lifecycle
  // ═══════════════════════════════════════════════════════════════════

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83E\uDDE0 Knowledge',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
        spacing: 8,
      })
    );

    // Tab bar for type filtering
    const { widgetIds: [tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'tabBar', windowId: this.windowId, tabs: TAB_LABELS, selectedIndex: 0, closable: false }],
      })
    );
    this.tabBarId = tabBarId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Toolbar: 'Show archived' toggle (left) + Curate button (right)
    const toolbarRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    this.toolbarRowId = toolbarRowId;
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: toolbarRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const { widgetIds: [archToggleId, curateId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'checkbox', windowId: this.windowId, checked: this.showArchived, text: 'Show archived' },
          { type: 'button', windowId: this.windowId, text: 'Curate',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        ],
      })
    );
    this.archivedToggleId = archToggleId;
    this.curateBtnId = curateId;

    await this.request(request(this.id, toolbarRowId, 'addLayoutChild', {
      widgetId: this.archivedToggleId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 140, height: 24 },
    }));
    await this.request(request(this.id, toolbarRowId, 'addLayoutSpacer', {}));
    await this.request(request(this.id, toolbarRowId, 'addLayoutChild', {
      widgetId: this.curateBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 80, height: 26 },
    }));

    // Split panes: outer = list | rest; inner = map | detail. The map pane
    // exists only visually on the Patterns tab (inner divider collapses to 0
    // elsewhere), so the other tabs keep their two-pane layout.
    const { widgetIds: [splitId, innerSplitId, graphId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'splitPane',
            windowId: this.windowId,
            orientation: 'horizontal',
            dividerPosition: 0.3,
            minSize: 160,
          },
          {
            type: 'splitPane',
            windowId: this.windowId,
            orientation: 'horizontal',
            dividerPosition: 0,
            minSize: 0,
          },
          // The pattern language map (hidden until the Patterns tab is active).
          {
            type: 'nodeGraph',
            windowId: this.windowId,
            title: 'Pattern language',
            emptyText: 'No patterns yet',
            directed: true,
            groups: [
              { id: 'pattern', label: 'Written', color: '$textPrimary', material: 'ceramic', shape: 'sphere' },
              { id: 'unwritten', label: 'Unwritten', color: '$textSecondary', shape: 'icosphere' },
            ],
            style: { visible: false },
          },
        ],
      })
    );
    this.splitPaneId = splitId;
    this.innerSplitId = innerSplitId;
    this.graphId = graphId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.splitPaneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Left pane: search input + list (detached VBox)
    this.leftLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 4,
      })
    );

    // Search input
    const { widgetIds: [searchId, listId, listEmptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId, placeholder: 'Search knowledge...' },
          { type: 'list', windowId: this.windowId, items: [], searchable: false, itemHeight: 26 },
          { type: 'label', windowId: this.windowId, text: this.listEmptyText(), style: emptyStateStyle(this.theme) },
        ],
      })
    );
    this.searchInputId = searchId;
    this.listWidgetId = listId;
    this.listEmptyId = listEmptyId;

    await this.request(request(this.id, this.leftLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.searchInputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 28 } },
        { widgetId: this.listWidgetId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.listEmptyId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Right pane: detail (scrollable VBox)
    this.detailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 8,
      })
    );

    // Detail pane widgets
    const { widgetIds: detailIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // 0: title
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 14, fontWeight: 'bold', color: this.theme.textHeading, wordWrap: true } },
          // 1: type badge
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textSecondary } },
          // 2: tags
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.statusNeutral } },
          // 3: metadata
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 10, color: this.theme.textMeta, wordWrap: true } },
          // 4: divider
          { type: 'divider', windowId: this.windowId },
          // 5: content (markdown, selectable)
          { type: 'markdown', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true, selectable: true } },
          // 6: delete button
          { type: 'button', windowId: this.windowId, text: 'Forget',
            style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder } },
          // 7: restore button (archived entries only; the primary action there)
          { type: 'button', windowId: this.windowId, text: 'Restore',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
          // 8: empty state
          { type: 'label', windowId: this.windowId,
            text: this.detailEmptyText(),
            style: emptyStateStyle(this.theme) },
        ],
      })
    );

    this.titleLabelId = detailIds[0];
    this.typeLabelId = detailIds[1];
    this.tagsLabelId = detailIds[2];
    this.metaLabelId = detailIds[3];
    const dividerId = this.dividerId = detailIds[4];
    this.contentLabelId = detailIds[5];
    this.deleteBtnId = detailIds[6];
    this.restoreBtnId = detailIds[7];
    this.emptyLabelId = detailIds[8];

    // Pattern link rows: outgoing 'Links' and reverse 'Linked from'. Chips
    // are created per selected pattern in renderPatternLinks; the rows
    // themselves persist (empty rows collapse to zero height).
    this.linksRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    this.linkedFromRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );

    // Button row (Forget + Restore side by side)
    this.buttonRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    await this.request(request(this.id, this.buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.deleteBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
        { widgetId: this.restoreBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
      ],
    }));

    await this.request(request(this.id, this.detailLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.emptyLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.titleLabelId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.typeLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: this.tagsLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: this.metaLabelId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: dividerId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 1 } },
        { widgetId: this.contentLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.linksRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.linkedFromRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.buttonRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } },
      ],
    }));

    // Wire split panes: outer = list | inner; inner = graph | detail
    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.leftLayoutId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.innerSplitId }));
    await this.request(request(this.id, this.innerSplitId, 'setLeftChild', { widgetId: this.graphId }));
    await this.request(request(this.id, this.innerSplitId, 'setRightChild', { widgetId: this.detailLayoutId }));

    // Subscribe to events
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.searchInputId, 'addDependent', {}));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.deleteBtnId, 'addDependent', {}));
    this.send(request(this.id, this.restoreBtnId, 'addDependent', {}));
    this.send(request(this.id, this.archivedToggleId, 'addDependent', {}));
    this.send(request(this.id, this.curateBtnId, 'addDependent', {}));
    this.send(request(this.id, this.graphId, 'addDependent', {}));
    if (this.knowledgeBaseId) {
      this.send(request(this.id, this.knowledgeBaseId, 'addDependent', {}));
    }
    this.subscribeDocumentMap();

    // Show empty state, hide detail widgets
    await this.showEmptyState(true);

    // Load initial data
    await this.loadEntries();

    // Autofocus the search input so the user can start typing immediately
    // (Paradox of the Active User — surface the primary action without an
    // extra click).
    if (this.windowId && this.searchInputId && this.rootLayoutId) {
      try {
        await this.request(request(this.id, this.windowId, 'focusChild', {
          widgetId: this.searchInputId,
          parentChildId: this.rootLayoutId,
        }));
      } catch { /* window gone */ }
    }

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.knowledgeBaseId) {
      this.send(request(this.id, this.knowledgeBaseId, 'removeDependent', {}));
    }
    if (this.documentMapId && this.documentMapSubscribed) {
      this.send(request(this.id, this.documentMapId, 'removeDependent', {}));
    }
    this.documentMapSubscribed = false;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.splitPaneId = undefined;
    this.searchInputId = undefined;
    this.listWidgetId = undefined;
    this.leftLayoutId = undefined;
    this.detailLayoutId = undefined;
    this.titleLabelId = undefined;
    this.typeLabelId = undefined;
    this.tagsLabelId = undefined;
    this.metaLabelId = undefined;
    this.contentLabelId = undefined;
    this.deleteBtnId = undefined;
    this.restoreBtnId = undefined;
    this.buttonRowId = undefined;
    this.emptyLabelId = undefined;
    this.dividerId = undefined;
    this.listEmptyId = undefined;
    this.listEmptyShown = undefined;
    this.archivedToggleId = undefined;
    this.curateBtnId = undefined;
    this.toolbarRowId = undefined;
    this.learningPaneId = undefined;
    this.learningRefreshId = undefined;
    this.learningStatusId = undefined;
    this.learningRowIds = [];
    this.learningPaneReady = undefined;
    this.learningShown = false;
    this.learningLoaded = false;
    this.learningLoading = false;
    this.innerSplitId = undefined;
    this.graphId = undefined;
    this.graphLinks.clear();
    this.linksRowId = undefined;
    this.linkedFromRowId = undefined;
    this.linkRowWidgets = [];
    this.linkButtons.clear();
    this.graphShown = false;
    this.mapRows = [];
    this.filteredMapRows = [];
    this.mapsAvailable = true;
    this.selectedPage = undefined;
    this.graphMapId = undefined;
    this.entries = [];
    this.filteredEntries = [];
    this.selectedId = undefined;
    this.activeTab = 0;
    this.searchQuery = '';
    this.showArchived = false;
    this.lastArrivalFlashAt = 0;
    this.changed('visibility', false);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Data loading
  // ═══════════════════════════════════════════════════════════════════

  private async loadEntries(): Promise<void> {
    // The Learning tab shows no entries (its list is hidden) and the Maps tab
    // lists map pages (loadMapPages); the next tab change reloads.
    if (!this.knowledgeBaseId || this.activeTab === LEARNING_TAB || this.activeTab === MAPS_TAB) return;

    try {
      const typeFilter = TAB_TYPES[this.activeTab];

      if (this.searchQuery.trim().length > 0) {
        // Full-text search via KnowledgeBase recall (searches title + content + tags)
        this.filteredEntries = await this.request<KnowledgeEntry[]>(
          request(this.id, this.knowledgeBaseId, 'recall', {
            query: this.searchQuery,
            type: typeFilter,
            limit: 50,
          })
        );
      } else {
        // No search query: list all, filtered by type
        this.filteredEntries = await this.request<KnowledgeEntry[]>(
          request(this.id, this.knowledgeBaseId, 'list', {
            type: typeFilter,
            limit: 200,
            ...(this.showArchived ? { includeArchived: true } : {}),
          })
        );
      }

      // Keep full entries cache for detail view
      if (!this.searchQuery) {
        this.entries = this.filteredEntries;
      }

      await this.rebuildList();
    } catch (err) {
      log.warn('Failed to load entries:', err instanceof Error ? err.message : String(err));
    }
  }

  /** Reload whatever the list shows on the active tab: map pages or knowledge entries. */
  private async reloadList(): Promise<void> {
    if (this.activeTab === MAPS_TAB) await this.loadMapPages();
    else await this.loadEntries();
  }

  // ─── Maps tab (DocumentMap pages) ──────────────────────────────────

  /** DocumentMap, discovered again when it was missing (it may spawn after this window). */
  private async documentMap(): Promise<AbjectId | undefined> {
    this.documentMapId = await this.resolveDep('DocumentMap', this.documentMapId).catch(() => undefined);
    this.subscribeDocumentMap();
    return this.documentMapId;
  }

  /** Hear DocumentMap's page and map changes while the window is open. */
  private subscribeDocumentMap(): void {
    if (!this.windowId || !this.documentMapId || this.documentMapSubscribed) return;
    this.documentMapSubscribed = true;
    this.send(request(this.id, this.documentMapId, 'addDependent', {}));
  }

  /**
   * Run one reload of a kind at a time. Changes that arrive during a reload
   * (an agent writing a map page by page) are answered by one more run
   * after it, not one run each.
   */
  private async coalesceReload(key: string, run: () => Promise<void>): Promise<void> {
    const running = this.mapReloads.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.mapReloads.set(key, state);
    try {
      do {
        state.again = false;
        await run();
      } while (state.again && this.activeTab === MAPS_TAB && this.windowId);
    } finally {
      if (this.mapReloads.get(key) === state) this.mapReloads.delete(key);
    }
  }

  /** Reload the Maps tab's list. */
  private async loadMapPages(): Promise<void> {
    await this.coalesceReload('list', () => this.readMapPages());
  }

  /**
   * DocumentMap changed: reload the list, the page on show when it was the
   * one changed (or is gone), and the graph when it draws that map.
   */
  private async mapsChanged(aspect: string, value: unknown): Promise<void> {
    if (this.activeTab !== MAPS_TAB || !this.windowId) return;
    const change = (value && typeof value === 'object' ? value : {}) as { map?: string; title?: string };
    const touches = (map: string | undefined) => !!map && (aspect === 'mapsChanged' || change.map === map);
    await this.loadMapPages();

    // The map the graph draws was removed: close the pane.
    if (aspect === 'mapsChanged' && this.graphMapId && !this.mapRows.some(r => r.map === this.graphMapId)) {
      this.graphMapId = undefined;
      await this.updateGraphPane();
    }
    const shown = this.selectedPage;
    if (shown && touches(shown.map) && (aspect === 'mapsChanged' || !change.title || linkKey(change.title) === linkKey(shown.title))) {
      await this.coalesceReload('page', () => this.refreshSelectedPage());
    }
    if (touches(this.graphMapId)) {
      await this.coalesceReload('graph', () => this.loadGraph());
      const changed = change.title ? this.mapRows.find(r => r.map === change.map && linkKey(r.title) === linkKey(change.title!)) : undefined;
      if (changed && changed.map === this.graphMapId) await this.pulseNode(PAGE_PREFIX + changed.slug);
    }
  }

  /** Read the page on show again; when it is gone, the detail pane empties. */
  private async refreshSelectedPage(): Promise<void> {
    const shown = this.selectedPage;
    const dm = this.documentMapId;
    if (!shown || !dm) return;
    const view = await this.request<(MapPageView & { found: true }) | { found: false }>(
      request(this.id, dm, 'readPage', { map: shown.map, page: shown.slug }),
    ).catch(() => ({ found: false as const }));
    if (this.selectedPage !== shown || this.activeTab !== MAPS_TAB) return; // another page was chosen meanwhile
    if (view.found) {
      this.selectedPage = { map: view.map, slug: view.slug, title: view.title };
      await this.showPageDetail(view);
    } else {
      this.selectedPage = undefined;
      await this.showEmptyState(true);
    }
  }

  /** Read every map's pages (and the search's hits) from DocumentMap, then rebuild the list. */
  private async readMapPages(): Promise<void> {
    const dm = await this.documentMap();
    let rows: MapPageRow[] = [];
    let available = !!dm;
    if (dm) {
      try {
        const maps = await this.request<Array<{ id: string }>>(request(this.id, dm, 'listMaps', {}));
        const details = await Promise.all((Array.isArray(maps) ? maps : []).map(m =>
          this.request<MapDetail>(request(this.id, dm, 'getMap', { map: m.id })).catch(() => null)));
        rows = details
          .filter((d): d is MapDetail => !!d && typeof d.id === 'string')
          .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.id.localeCompare(b.id))
          // getMap lists the index first, then pages by title.
          .flatMap(d => (d.pages ?? []).map(p => ({
            map: d.id, mapName: d.name || d.id, mapKind: d.kind,
            title: p.title, slug: p.slug, revision: count(p.revision), writer: p.writer ?? 'unknown',
            updatedAt: count(p.updatedAt), sources: count(p.sources),
            flagged: p.flagged === true, editedInFiles: p.editedInFiles === true,
          })));
      } catch (err) {
        available = false;
        this.documentMapId = undefined; // rediscover next time: it may have been respawned
        this.documentMapSubscribed = false;
        log.warn('Maps unavailable:', err instanceof Error ? err.message : String(err));
      }
    }

    let shown = rows;
    const query = this.searchQuery.trim();
    if (dm && available && query) {
      const hits = await this.request<Array<{ map: string; title: string }>>(
        request(this.id, dm, 'search', { query, limit: MAP_SEARCH_LIMIT }),
      ).catch(() => [] as Array<{ map: string; title: string }>);
      const byKey = new Map(rows.map(r => [`${r.map}#${linkKey(r.title)}`, r]));
      const seen = new Set<MapPageRow>();
      shown = [];
      for (const hit of Array.isArray(hits) ? hits : []) {
        const row = byKey.get(`${hit.map}#${linkKey(String(hit.title ?? ''))}`);
        if (row && !seen.has(row)) { seen.add(row); shown.push(row); }
      }
    }

    if (this.activeTab !== MAPS_TAB || !this.windowId) return; // left the tab meanwhile
    this.mapsAvailable = available;
    this.mapRows = rows;
    this.filteredMapRows = shown;
    await this.rebuildMapList();
    ensure(this.filteredMapRows.every(r => this.mapRows.includes(r)), 'the list shows only known map pages');
  }

  private mapRowKey(map: string, slug: string): string {
    return `${map}#${slug}`;
  }

  /** A page's name in the list and the detail title: an index reads as its map's name. */
  private mapPageLabel(row: { slug: string; title: string; mapName: string }): string {
    return row.slug === INDEX_SLUG ? `${row.mapName} (index)` : row.title;
  }

  private async rebuildMapList(): Promise<void> {
    if (!this.listWidgetId) return;
    const items: ListItem[] = this.filteredMapRows.map(row => ({
      label: this.mapPageLabel(row),
      value: this.mapRowKey(row.map, row.slug),
      secondary: [row.map, `revision ${row.revision}`, row.writer].join('  ·  '),
      badge: row.flagged
        ? { text: 'flagged', color: this.theme.statusWarning }
        : row.editedInFiles
          ? { text: 'edited in Files', color: this.theme.statusNeutral }
          : { text: row.mapKind, color: row.mapKind === 'project' ? this.theme.textHeading : this.theme.textSecondary },
    }));
    await this.request(request(this.id, this.listWidgetId, 'update', { items })).catch(() => { /* list gone */ });
    await this.applyListEmpty(items.length === 0);
  }

  /**
   * Open a page of a map: read it from DocumentMap, show it in the detail
   * pane, select it in the list, and draw its map in the graph pane. `page`
   * is a slug, title or alias (DocumentMap resolves each).
   */
  private async selectMapPage(map: string, page: string): Promise<void> {
    precondition(map.length > 0 && page.length > 0, 'a map page is named by its map and page');
    const dm = await this.documentMap();
    if (!dm) return;
    const view = await this.request<(MapPageView & { found: true }) | { found: false; error?: string }>(
      request(this.id, dm, 'readPage', { map, page }),
    ).catch((err) => ({ found: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (this.activeTab !== MAPS_TAB || !this.windowId) return; // left the tab meanwhile
    if (!view.found) {
      this.playEffect('shake');
      await this.notify(`That page is not in the map now${view.error ? `: ${view.error.slice(0, 80)}` : ''}`, 'warning');
      return;
    }
    this.selectedPage = { map: view.map, slug: view.slug, title: view.title };
    const idx = this.filteredMapRows.findIndex(r => r.map === view.map && r.slug === view.slug);
    if (idx >= 0 && this.listWidgetId) {
      await this.request(request(this.id, this.listWidgetId, 'update', { selectedIndex: idx })).catch(() => { /* list gone */ });
    }
    await this.showPageDetail(view);
    if (this.graphMapId !== view.map) {
      this.graphMapId = view.map;
      await this.updateGraphPane();
    } else {
      await this.selectOnMap(PAGE_PREFIX + view.slug);
    }
  }

  /** This peer's id, falling back to the object id before Identity resolves. */
  private get selfPeerId(): string {
    return this.localPeerId || this.id;
  }

  /**
   * An entry authored by another peer. These are shown with their origin peer
   * and are read-only here: forgetting or restoring one would only be undone
   * by the owning peer's next sync, so the controls are withheld instead.
   */
  private isRemoteEntry(entry: KnowledgeEntry): boolean {
    const creator = entry.creatorPeerId;
    return !!creator && creator !== this.selfPeerId;
  }

  /** Short, stable label for a peer id in the UI. */
  private peerLabel(peerId: string): string {
    return peerId.slice(0, 8);
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;

    const items: ListItem[] = this.filteredEntries.map(entry => {
      const tagStr = entry.tags.length > 0 ? entry.tags.slice(0, 3).join(', ') : '';
      const remote = this.isRemoteEntry(entry);
      // Compact second line: origin badge text + peer + usefulness + tags
      const parts: string[] = [entry.origin];
      if (remote) parts.push(`peer ${this.peerLabel(entry.creatorPeerId!)}`);
      if (entry.usefulCount > 0) parts.push(`useful ×${entry.usefulCount}`);
      if (tagStr) parts.push(tagStr);
      return {
        label: entry.title,
        value: entry.id,
        secondary: parts.join('  ·  '),
        badge: entry.archived
          ? { text: 'archived', color: this.theme.textTertiary }
          : remote
            ? { text: `remote · ${entry.type}`, color: this.theme.textTertiary }
            : { text: entry.type, color: this.typeColor(entry.type) },
      };
    });

    await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    await this.applyListEmpty(items.length === 0);
  }

  /** Empty-list text for the current tab and search. */
  private listEmptyText(): string {
    if (this.activeTab === MAPS_TAB && !this.mapsAvailable) {
      return emptyStateMarkdown('Maps are unavailable', 'The document map for this workspace did not answer. Try again in a moment.');
    }
    if (this.searchQuery.trim().length > 0) {
      return emptyStateMarkdown('No matches', 'Try other words, or clear the search to see everything.');
    }
    if (this.activeTab === MAPS_TAB) return emptyStateMarkdown(MAPS_EMPTY_TITLE, MAPS_EMPTY_BODY);
    const type = TAB_TYPES[this.activeTab];
    if (type === 'pattern') {
      return emptyStateMarkdown(
        'No patterns yet',
        'Patterns are reusable lessons woven from finished goals. They appear here as agents complete work.',
      );
    }
    const titles: Record<string, string> = {
      learned: 'No lessons learned yet', fact: 'No facts yet',
      insight: 'No insights yet', reference: 'No references yet',
    };
    return emptyStateMarkdown(
      type ? (titles[type] ?? 'Nothing here yet') : 'Nothing remembered yet',
      'Agents record what they learn here as they work. Ask in Chat to remember something, for example "remember that I prefer metric units".',
    );
  }

  /** Swap the list and its empty-state label, refreshing the text. */
  private async applyListEmpty(empty: boolean): Promise<void> {
    if (!this.listWidgetId || !this.listEmptyId) return;
    try {
      if (empty) {
        await this.request(request(this.id, this.listEmptyId, 'update', { text: this.listEmptyText() }));
      }
      if (this.listEmptyShown === empty) return;
      this.listEmptyShown = empty;
      await Promise.all([
        this.request(request(this.id, this.listWidgetId, 'update', { style: { visible: !empty } })),
        this.request(request(this.id, this.listEmptyId, 'update', { style: { visible: empty } })),
      ]);
    } catch { /* widgets may be gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Curation
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Ask the reviewer to run a knowledge curation pass. The reply arrives
   * immediately ({ started, message? }); curation itself runs in the
   * background and results land via the KnowledgeBase entry-change events
   * this browser already subscribes to.
   */
  private async runCurate(): Promise<void> {
    if (!this.curateBtnId) return;

    this.send(event(this.id, this.curateBtnId, 'update', { busy: true }));
    try {
      const reviewerId = await this.discoverDep('TaskReviewer');
      if (!reviewerId) {
        this.playEffect('shake');
        await this.notify('Reviewer not available', 'warning');
        return;
      }

      const reply = await this.request<{ started: boolean; message?: string }>(
        request(this.id, reviewerId, 'curate', {})
      );
      // Started: the request landed (hand-coloured, the user asked for it).
      // Not started: the reviewer turned it away.
      this.playEffect(reply.started ? 'flash' : 'shake', reply.started ? '$accent' : undefined);
      await this.notify(
        reply.message ?? (reply.started ? 'Curation started' : 'Curation did not start'),
        reply.started ? 'info' : 'warning'
      );
    } catch (err) {
      this.playEffect('shake');
      const msg = err instanceof Error ? err.message : String(err);
      await this.notify(`Curate failed: ${msg.slice(0, 80)}`, 'error');
    } finally {
      this.send(event(this.id, this.curateBtnId, 'update', { busy: false }));
    }
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Detail pane
  // ═══════════════════════════════════════════════════════════════════

  /** The detail pane's empty-state text for the active tab. */
  private detailEmptyText(): string {
    return this.activeTab === MAPS_TAB
      ? emptyStateMarkdown('Select a page', 'Pick one from the list to read it, see the sources it cites, and follow its links to other pages.')
      : emptyStateMarkdown('Select an entry', 'Pick one from the list to read it in full, see its tags and links, and forget or restore it.');
  }

  private async showEmptyState(empty: boolean): Promise<void> {
    if (!this.emptyLabelId) return;
    const detailVis = !empty;
    if (empty) await this.clearLinkRows();

    await Promise.all([
      this.request(request(this.id, this.emptyLabelId, 'update', {
        ...(empty ? { text: this.detailEmptyText() } : {}),
        style: { visible: empty },
      })),
      this.request(request(this.id, this.titleLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.typeLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.tagsLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.metaLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.contentLabelId!, 'update', { style: { visible: detailVis } })),
      ...(this.dividerId ? [this.request(request(this.id, this.dividerId, 'update', { style: { visible: detailVis } }))] : []),
      this.request(request(this.id, this.deleteBtnId!, 'update', { style: { visible: detailVis } })),
      // Restore stays hidden until showDetail() reveals it for archived entries
      this.request(request(this.id, this.restoreBtnId!, 'update', { style: { visible: false } })),
    ]);
  }

  private async showDetail(entry: KnowledgeEntry): Promise<void> {
    await this.showEmptyState(false);

    const typeColor = this.typeColor(entry.type);
    const created = new Date(entry.createdAt).toLocaleDateString();
    const updated = new Date(entry.updatedAt).toLocaleDateString();
    const tagsStr = entry.tags.length > 0 ? entry.tags.join(', ') : 'none';
    const usefulStr = entry.usefulCount > 0 ? `  |  Useful ×${entry.usefulCount}` : '';
    // Entries synced from another peer are labelled and left read-only.
    const remote = this.isRemoteEntry(entry);
    const peerStr = remote ? `  |  Peer ${this.peerLabel(entry.creatorPeerId!)} (read-only)` : '';

    await Promise.all([
      this.request(request(this.id, this.titleLabelId!, 'update', {
        text: entry.title,
        // Archived entries render dimmed
        style: { color: entry.archived ? this.theme.textTertiary : this.theme.textHeading, visible: true },
      })),
      this.request(request(this.id, this.typeLabelId!, 'update', {
        text: entry.archived ? `${entry.type}  ·  archived` : entry.type,
        style: { color: entry.archived ? this.theme.textTertiary : typeColor, visible: true },
      })),
      this.request(request(this.id, this.tagsLabelId!, 'update', {
        text: `Tags: ${tagsStr}`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.metaLabelId!, 'update', {
        text: `Origin: ${entry.origin}${peerStr}  |  Created ${created}  |  Updated ${updated}  |  Accessed ${entry.accessCount} times${usefulStr}  |  ${evidenceText(entry)}`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.restoreBtnId!, 'update', {
        style: { visible: entry.archived && !remote },
      })),
      // showEmptyState() reveals Forget for every detail render; a remote
      // entry takes it away again.
      // The same button forgets a live entry and deletes an archived one, and
      // its label says which.
      this.request(request(this.id, this.deleteBtnId!, 'update', {
        text: entry.archived ? 'Delete' : 'Forget',
        style: { visible: !remote },
      })),
      this.request(request(this.id, this.contentLabelId!, 'update', {
        text: this.displayContent(entry),
        style: { visible: true },
      })),
    ]);

    await this.renderPatternLinks(entry);
  }

  /**
   * Show a map page: its map, revision, writer and source root above the
   * body, any flags readers raised and the sources it cites around it, and
   * its links as chips. An index page adds its map's lint summary. Pages are
   * written by agents or edited in Files, so Forget and Restore stay hidden.
   */
  private async showPageDetail(view: MapPageView): Promise<void> {
    await this.showEmptyState(false);
    const row = this.mapRows.find(r => r.map === view.map && r.slug === view.slug);
    const mapName = row?.mapName ?? view.map;
    const isIndex = view.slug === INDEX_SLUG;
    const sources = Array.isArray(view.sources) ? view.sources : [];
    const flags = Array.isArray(view.flags) ? view.flags : [];
    const root = view.sourceRoot ? `${view.sourceRoot.kind === 'host' ? 'this computer' : 'Files'}: ${view.sourceRoot.root}` : 'unknown';
    const updated = view.updatedAt ? new Date(view.updatedAt).toLocaleDateString() : 'unknown';

    const meta = [
      `Map ${view.map}`,
      `Revision ${count(view.revision)}`,
      `Written by ${view.writer || 'unknown'}`,
      `Updated ${updated}`,
      `Sources in ${root}`,
    ];
    if (isIndex) {
      const dm = await this.documentMap();
      const lint = dm
        ? await this.request<MapLint>(request(this.id, dm, 'lint', { map: view.map })).catch(() => null)
        : null;
      if (lint) meta.push(`Checks: ${lintSummary(lint)}`);
    }

    const notes: string[] = [];
    for (const f of flags) {
      const when = f.at ? ` on ${new Date(f.at).toLocaleDateString()}` : '';
      notes.push(`> **Flagged** by ${f.by || 'a reader'}${when}: ${String(f.reason ?? '').replace(/\n+/g, ' ')}`);
    }
    if (view.editedInFiles) notes.push('> Edited in Files since an agent last wrote it.');
    const cited = sources.length > 0
      ? `**Sources**\n\n${sources.map(s => `- \`${s.path}\``).join('\n')}`
      : '';
    const content = [notes.join('\n>\n'), view.body ?? '', cited].filter(Boolean).join('\n\n---\n\n');

    await Promise.all([
      this.request(request(this.id, this.titleLabelId!, 'update', {
        text: this.mapPageLabel({ slug: view.slug, title: view.title, mapName }),
        style: { color: this.theme.textHeading, visible: true },
      })),
      this.request(request(this.id, this.typeLabelId!, 'update', {
        text: `${row?.mapKind === 'project' ? 'Project map' : 'Document map'}  ·  ${mapName}${isIndex ? '  ·  index' : ''}`,
        style: { color: view.flagged ? this.theme.statusWarning : this.theme.textSecondary, visible: true },
      })),
      this.request(request(this.id, this.tagsLabelId!, 'update', {
        text: [
          sources.length > 0 ? `Cites ${plural(sources.length, 'source', 'sources')}` : 'Cites no sources',
          ...(flags.length > 0 ? [plural(flags.length, 'flag', 'flags')] : []),
        ].join('  ·  '),
        style: { visible: true },
      })),
      this.request(request(this.id, this.metaLabelId!, 'update', {
        text: meta.join('  |  '),
        style: { visible: true },
      })),
      this.request(request(this.id, this.deleteBtnId!, 'update', { style: { visible: false } })),
      this.request(request(this.id, this.restoreBtnId!, 'update', { style: { visible: false } })),
      this.request(request(this.id, this.contentLabelId!, 'update', { text: content, style: { visible: true } })),
    ]);

    await this.renderPageLinks(view);
  }

  /**
   * A map page's neighborhood: its links as chips that open the page, names
   * no page answers yet as dimmed "unwritten" labels, and a row of the pages
   * that link to it.
   */
  private async renderPageLinks(view: MapPageView): Promise<void> {
    await this.clearLinkRows();
    if (!this.linksRowId || !this.linkedFromRowId) return;
    // A page that names itself needs no chip back to itself.
    const self = new Set([linkKey(view.title), linkKey(view.slug)]);
    const links = (Array.isArray(view.links) ? view.links : []).filter(name => !self.has(linkKey(name)));
    const unwritten = Array.isArray(view.unwrittenLinks) ? view.unwrittenLinks : [];
    const linkedFrom = Array.isArray(view.linkedFrom) ? view.linkedFrom : [];
    await this.renderLinkRows(
      [
        ...links.map(name => ({ text: name, target: { kind: 'page' as const, map: view.map, page: name } })),
        ...unwritten.map(name => ({ text: `${name} (unwritten)`, dim: true })),
      ],
      [...new Set(linkedFrom)].map(title => {
        const row = this.mapRows.find(r => r.map === view.map && r.title === title);
        return { text: row ? this.mapPageLabel(row) : title, target: { kind: 'page' as const, map: view.map, page: row?.slug ?? title } };
      }),
    );
  }

  /**
   * Fill the link rows: 'Links:' then the outgoing chips, 'Linked from:' then
   * the incoming ones. A row with nothing to show stays empty (zero height).
   */
  private async renderLinkRows(
    outgoing: Array<{ text: string; dim?: boolean; target?: LinkTarget }>,
    incoming: Array<{ text: string; target: LinkTarget }>,
  ): Promise<void> {
    if (!this.linksRowId || !this.linkedFromRowId) return;
    if (outgoing.length > 0) {
      await this.addLinkChip(this.linksRowId, { text: 'Links:' });
      for (const chip of outgoing) await this.addLinkChip(this.linksRowId, chip);
    }
    if (incoming.length > 0) {
      await this.addLinkChip(this.linkedFromRowId, { text: 'Linked from:' });
      for (const chip of incoming) await this.addLinkChip(this.linkedFromRowId, chip);
    }
  }

  // ─── Pattern link navigation ───────────────────────────────────────

  /** Lowercase, strip punctuation, collapse whitespace — the same title key KnowledgeBase resolves links by. */
  private normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /**
   * A pattern's links, off its structure. The browser used to hunt for a
   * 'Links:' line here, so patterns that wrote their links as a '## Links'
   * block drew as isolated nodes in the graph even though they were linked.
   */
  private parsePatternLinks(content: string): string[] {
    return readPattern(content)?.links ?? [];
  }

  /**
   * Patterns are stored as structure. The KnowledgeBase renders them before
   * handing them out, so this normally receives prose already; it renders
   * anyway, because an entry can also arrive raw over cross-peer sync and a
   * wall of JSON is not what the detail pane is for.
   */
  private displayContent(entry: { type: string; content: string; title: string }): string {
    if (entry.type !== 'pattern') return entry.content;
    const pattern = readStructured(entry.content);
    return pattern ? renderPatternText(pattern) : entry.content;
  }

  private async clearLinkRows(): Promise<void> {
    const widgets = this.linkRowWidgets;
    this.linkRowWidgets = [];
    this.linkButtons.clear();
    for (const { rowId, widgetId } of widgets) {
      try {
        await this.request(request(this.id, rowId, 'removeLayoutChild', { widgetId }));
      } catch { /* row already gone */ }
      try {
        await this.request(request(this.id, widgetId, 'destroy', {}));
      } catch { /* widget already gone */ }
    }
  }

  /**
   * Render the selected pattern's language neighborhood: its outgoing
   * link names as clickable chips (dimmed "unwritten" when no pattern
   * has that title yet) and a reverse row of patterns whose Links name it.
   * Non-pattern entries just clear the rows.
   */
  private async renderPatternLinks(entry: KnowledgeEntry): Promise<void> {
    await this.clearLinkRows();
    if (entry.type !== 'pattern' || !this.linksRowId || !this.linkedFromRowId || !this.knowledgeBaseId) return;

    const patterns = await this.request<KnowledgeEntry[]>(
      request(this.id, this.knowledgeBaseId, 'list', { type: 'pattern', limit: 200 }),
    ).catch(() => [] as KnowledgeEntry[]);
    const byTitle = new Map(patterns.map(p => [this.normalizeTitle(p.title), p]));

    const outgoing = this.parsePatternLinks(entry.content);
    const selfNorm = this.normalizeTitle(entry.title);
    const incoming = patterns.filter(p =>
      p.id !== entry.id
      && this.parsePatternLinks(p.content).some(name => this.normalizeTitle(name) === selfNorm));

    const chips: Array<{ text: string; dim?: boolean; target?: LinkTarget }> = [];
    for (const name of outgoing) {
      const target = byTitle.get(this.normalizeTitle(name));
      if (target && target.id !== entry.id) {
        chips.push({ text: target.title, target: { kind: 'entry', entry: target } });
      } else if (!target) {
        chips.push({ text: `${name} (unwritten)`, dim: true });
      }
    }
    await this.renderLinkRows(chips, incoming.map(p => ({ text: p.title, target: { kind: 'entry' as const, entry: p } })));
    log.info(`renderPatternLinks("${entry.title}"): ${outgoing.length} outgoing, ${incoming.length} incoming`);
  }

  /** Add one chip to a link row: a button when it leads to a pattern or map page, a label otherwise. */
  private async addLinkChip(
    rowId: AbjectId,
    chip: { text: string; dim?: boolean; target?: LinkTarget },
  ): Promise<void> {
    const spec = chip.target
      ? { type: 'button', windowId: this.windowId, text: chip.text }
      : {
          type: 'label', windowId: this.windowId, text: chip.text,
          style: { fontSize: 11, color: chip.dim ? this.theme.textTertiary : this.theme.textSecondary },
        };
    const { widgetIds: [widgetId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [spec] }),
    );
    await this.request(request(this.id, rowId, 'addLayoutChild', {
      widgetId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: Math.min(240, chip.text.length * 7 + (chip.target ? 24 : 8)), height: 24 },
    }));
    this.linkRowWidgets.push({ rowId, widgetId });
    if (chip.target) {
      this.linkButtons.set(widgetId, chip.target);
      this.send(request(this.id, widgetId, 'addDependent', {}));
    }
  }

  // ─── Graph pane: the pattern language, or the selected page's map ──

  /** Whether the graph pane is open with a graph in it. */
  private graphActive(): boolean {
    return this.graphShown && !!this.graphId;
  }

  /** The graph pane opens on the Patterns tab, and on the Maps tab once a page (so a map) is chosen. */
  private graphWanted(): boolean {
    if (this.activeTab === MAPS_TAB) return !!this.graphMapId;
    return TAB_TYPES[this.activeTab] === 'pattern';
  }

  /** Collapse or expand the graph pane to match the active tab, and draw it when open. */
  private async updateGraphPane(): Promise<void> {
    if (!this.innerSplitId || !this.graphId) return;
    const active = this.graphWanted();
    if (active !== this.graphShown) {
      this.graphShown = active;
      await this.request(request(this.id, this.innerSplitId, 'update', {
        dividerPosition: active ? 0.5 : 0,
      })).catch(() => { /* window torn down */ });
      await this.request(request(this.id, this.graphId, 'update', {
        style: { visible: active },
      })).catch(() => { /* window torn down */ });
    }
    if (active) await this.loadGraph();
  }

  /** Read the active tab's graph (patterns, or the chosen map's pages) and draw it. */
  private async loadGraph(): Promise<void> {
    if (!this.graphId) return;
    const source = this.activeTab === MAPS_TAB ? await this.mapGraphSource() : await this.patternGraphSource();
    if (!source || !this.graphActive()) return;
    await this.drawGraph(source);
  }

  /**
   * The language map's source: ALL workspace patterns (the search box
   * filters the list, never the map), each with the link names off its
   * structure, resolved by normalized title.
   */
  private async patternGraphSource(): Promise<GraphSource | null> {
    if (!this.knowledgeBaseId) return null;
    const patterns = await this.request<KnowledgeEntry[]>(
      request(this.id, this.knowledgeBaseId, 'list', { type: 'pattern', limit: 200 }),
    ).catch(() => [] as KnowledgeEntry[]);
    const byNorm = new Map(patterns.map((p) => [this.normalizeTitle(p.title), p.id]));
    return {
      title: 'Pattern language',
      emptyText: 'No patterns yet',
      items: patterns.map((p) => ({
        id: p.id, label: p.title, size: 8 + Math.min(6, p.usefulCount), links: this.parsePatternLinks(p.content),
      })),
      resolve: (name) => byNorm.get(this.normalizeTitle(name)),
      selectedId: this.selectedId,
    };
  }

  /**
   * The chosen map's source: one item per page (the index larger), each
   * with every link name its body uses. Names resolve by title, alias or
   * slug, as DocumentMap resolves them; the rest are pages still to write.
   */
  private async mapGraphSource(): Promise<GraphSource | null> {
    const mapId = this.graphMapId;
    const dm = mapId ? await this.documentMap() : undefined;
    if (!mapId || !dm) return null;
    const detail = await this.request<MapDetail>(request(this.id, dm, 'getMap', { map: mapId })).catch(() => null);
    if (!detail || this.graphMapId !== mapId) return null;
    const pages = detail.pages ?? [];
    const views = await Promise.all(pages.map(p =>
      this.request<Partial<MapPageView> & { found?: boolean }>(request(this.id, dm, 'readPage', { map: mapId, page: p.slug }))
        .catch(() => null)));
    if (this.graphMapId !== mapId) return null; // another map was chosen meanwhile

    const byKey = new Map<string, string>();
    const bySlug = new Map<string, string>();
    for (const p of pages) {
      const id = PAGE_PREFIX + p.slug;
      bySlug.set(p.slug, id);
      byKey.set(linkKey(p.title), id);
      for (const a of p.aliases ?? []) byKey.set(linkKey(a), id);
    }
    const items: GraphItem[] = pages.map((p, i) => {
      const v = views[i];
      const links = v?.found ? [...(v.links ?? []), ...(v.unwrittenLinks ?? [])] : [];
      return {
        id: PAGE_PREFIX + p.slug,
        label: p.slug === INDEX_SLUG ? `${detail.name} (index)` : p.title,
        size: p.slug === INDEX_SLUG ? 14 : 8 + Math.min(6, count(p.sources)),
        links,
      };
    });
    return {
      title: detail.name,
      emptyText: 'No pages in this map yet',
      items,
      resolve: (name) => byKey.get(linkKey(name)) ?? bySlug.get(name.trim()) ?? bySlug.get(slugOf(name)),
      selectedId: this.selectedPage?.map === mapId ? PAGE_PREFIX + this.selectedPage.slug : undefined,
    };
  }

  /**
   * Draw a graph source: one node per item, one directed edge per link
   * that resolves, and a see-through node per name nothing answers yet.
   * The widget keeps existing nodes where they are and springs the rest
   * into place.
   */
  private async drawGraph(source: GraphSource): Promise<void> {
    if (!this.graphId) return;
    const nodes: Array<Record<string, unknown>> = source.items.map((item) => ({
      id: item.id, label: item.label, group: 'pattern', size: item.size,
    }));
    const ghosts = new Set<string>();
    const edges: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    this.graphLinks.clear();
    for (const item of source.items) {
      const targets: string[] = [];
      for (const name of item.links) {
        let target = source.resolve(name);
        const ghost = target === undefined;
        if (ghost) {
          target = `${GHOST_PREFIX}${this.normalizeTitle(name)}`;
          if (!ghosts.has(target)) {
            ghosts.add(target);
            nodes.push({ id: target, label: name, group: 'unwritten', ghost: true, size: 6 });
          }
        }
        if (target === item.id || seen.has(`${item.id}>${target}`)) continue;
        seen.add(`${item.id}>${target}`);
        targets.push(target!);
        edges.push({ from: item.id, to: target, ...(ghost ? { style: 'dashed' } : {}) });
      }
      this.graphLinks.set(item.id, targets);
    }

    await this.request(request(this.id, this.graphId, 'update', { title: source.title, emptyText: source.emptyText }))
      .catch(() => { /* window torn down */ });
    await this.request(request(this.id, this.graphId, 'setGraph', { nodes, edges }))
      .catch((err) => log.warn('graph update failed:', err instanceof Error ? err.message : String(err)));
    if (source.selectedId && source.items.some((item) => item.id === source.selectedId)) {
      await this.request(request(this.id, this.graphId, 'select', { id: source.selectedId })).catch(() => {});
    }
    log.info(`${source.title} graph: ${nodes.length} nodes (${ghosts.size} unwritten), ${edges.length} links`);
  }

  /** Show the selection on the map (brought into view when it is outside). */
  private async selectOnMap(entryId: string | undefined): Promise<void> {
    if (!this.graphActive()) return;
    await this.request(request(this.id, this.graphId!, 'select', { id: entryId ?? null }))
      .catch(() => { /* not on the map (yet) */ });
  }

  /** A newly woven pattern (or a page just written) arrives as living light flowing along its links. */
  private async pulseNode(entryId: string): Promise<void> {
    if (!this.graphActive()) return;
    for (const target of (this.graphLinks.get(entryId) ?? []).slice(0, 6)) {
      await this.request(request(this.id, this.graphId!, 'pulse', { from: entryId, to: target, count: 2 }))
        .catch(() => { /* node not placed yet */ });
    }
  }

  /** Shared selection path for map clicks and link chips: sync list, detail pane, and map. */
  private async selectPattern(entry: KnowledgeEntry): Promise<void> {
    this.selectedId = entry.id;
    const idx = this.filteredEntries.findIndex(e => e.id === entry.id);
    if (idx >= 0 && this.listWidgetId) {
      await this.request(request(this.id, this.listWidgetId, 'update', { selectedIndex: idx }))
        .catch(() => { /* list gone */ });
    }
    await this.showDetail(idx >= 0 ? this.filteredEntries[idx] : entry);
    await this.selectOnMap(entry.id);
  }

  private typeColor(type: KnowledgeType): string {
    switch (type) {
      case 'learned': return this.theme.statusWarning;
      case 'fact': return this.theme.statusSuccess;
      case 'insight': return this.theme.statusNeutral;
      case 'reference': return this.theme.textSecondary;
      case 'pattern': return this.theme.textHeading;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Learning tab (a view over GoalManager's learning funnel)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show the Learning pane in place of the toolbar and the list/detail split
   * when the Learning tab is active, and the reverse otherwise. Reads the
   * active tab after building, so the last of several quick tab changes wins.
   */
  private async syncLearningPane(): Promise<void> {
    if (this.activeTab === LEARNING_TAB) await this.ensureLearningPane();
    const show = this.activeTab === LEARNING_TAB && !!this.learningPaneId;
    const setVisible = (id: AbjectId | undefined, visible: boolean) => id
      ? this.request(request(this.id, id, 'update', { style: { visible } })).catch(() => { /* window torn down */ })
      : Promise.resolve();
    if (this.learningShown !== show) {
      this.learningShown = show;
      await Promise.all([
        setVisible(this.splitPaneId, !show),
        setVisible(this.learningPaneId, show),
      ]);
    }
    // The toolbar (Show archived, Curate) acts on knowledge entries: the
    // Learning report and the Maps tab have none.
    await setVisible(this.toolbarRowId, !show && this.activeTab !== MAPS_TAB);
    if (show && !this.learningLoaded) await this.loadLearning();
  }

  private ensureLearningPane(): Promise<void> {
    this.learningPaneReady ??= this.buildLearningPane().catch((err) => {
      this.learningPaneReady = undefined;
      log.warn('Learning pane build failed:', err instanceof Error ? err.message : String(err));
    });
    return this.learningPaneReady;
  }

  /** The pane's fixed part: heading with Refresh, one line of explanation, a status line. Rows follow. */
  private async buildLearningPane(): Promise<void> {
    const windowId = this.windowId, rootId = this.rootLayoutId, wm = this.widgetManagerId;
    if (!windowId || !rootId || !wm) return;
    const noMargins = { top: 0, right: 0, bottom: 0, left: 0 };

    const paneId = await this.request<AbjectId>(request(this.id, wm, 'createDetachedScrollableVBox', {
      windowId, margins: { top: 8, right: 12, bottom: 8, left: 12 }, spacing: 6,
    }));
    const headerRowId = await this.request<AbjectId>(request(this.id, wm, 'createDetachedHBox', {
      windowId, margins: noMargins, spacing: 8,
    }));
    const { widgetIds: [titleId, refreshId, introId, statusId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wm, 'create', {
        specs: [
          { type: 'label', windowId, text: sectionHeaderText(this.theme, 'From prediction to knowledge'),
            style: { ...sectionHeaderStyle(this.theme), wordWrap: false } },
          { type: 'button', windowId, text: 'Refresh' },
          { type: 'label', windowId, text: LEARNING_INTRO, style: hintStyle(this.theme) },
          { type: 'label', windowId, text: 'Loading...', style: { fontSize: 11, color: this.theme.textMeta } },
        ],
      }),
    );
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: titleId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 24 } },
        { widgetId: refreshId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 26 } },
      ],
    }));
    await this.request(request(this.id, paneId, 'addLayoutChildren', {
      children: [
        { widgetId: headerRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } },
        { widgetId: introId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 34 } },
        { widgetId: statusId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
      ],
    }));
    // Hidden until syncLearningPane swaps it in, so it never shares the window with the list.
    await this.request(request(this.id, paneId, 'update', { style: { visible: false } }));
    if (this.windowId !== windowId) return; // closed while building
    await this.request(request(this.id, rootId, 'addLayoutChild', {
      widgetId: paneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    this.learningPaneId = paneId;
    this.learningRefreshId = refreshId;
    this.learningStatusId = statusId;
    this.send(request(this.id, refreshId, 'addDependent', {}));
  }

  /**
   * Read the funnel from GoalManager and rebuild the report rows. One load at
   * a time: a Refresh click delivered twice, or pressed during a load, is
   * answered by the load already running.
   */
  private async loadLearning(): Promise<void> {
    const paneId = this.learningPaneId;
    if (!paneId || this.learningLoading) return;
    this.learningLoading = true;
    const refreshId = this.learningRefreshId;
    if (refreshId) this.send(event(this.id, refreshId, 'update', { busy: true }));
    try {
      let funnel: LearningFunnel | null = null;
      let curve: LearningCurve | null = null;
      try {
        this.goalManagerId = await this.resolveDep('GoalManager', this.goalManagerId);
        const goalManagerId = this.goalManagerId;
        if (goalManagerId) {
          // The curve is read beside the funnel; either may be missing alone.
          const [f, c] = await Promise.allSettled([
            this.request<unknown>(request(this.id, goalManagerId, 'getLearningFunnel', {})),
            this.request<unknown>(request(this.id, goalManagerId, 'getLearningCurve', { weeks: CURVE_WEEKS })),
          ]);
          if (f.status === 'fulfilled') funnel = readFunnel(f.value);
          else throw f.reason;
          if (c.status === 'fulfilled') {
            try { curve = readCurve(c.value); } catch (err) { log.warn('Learning curve unreadable:', err instanceof Error ? err.message : String(err)); }
          } else {
            log.warn('Learning curve unavailable:', c.reason instanceof Error ? c.reason.message : String(c.reason));
          }
        }
      } catch (err) {
        this.goalManagerId = undefined; // rediscover next time: it may have been respawned
        log.warn('Learning funnel unavailable:', err instanceof Error ? err.message : String(err));
      }
      if (this.learningPaneId !== paneId) return; // window closed meanwhile

      await this.clearLearningRows();
      const status = funnel
        ? `Counts cover the ${funnel.scope}. All time counts every update since tracking began.`
        : LEARNING_UNAVAILABLE;
      await this.request(request(this.id, this.learningStatusId!, 'update', { text: status })).catch(() => {});
      if (funnel) {
        const curveReport: ReportRow[] = curve ? curveRows(curve)
          : [{ kind: 'heading', text: 'Week by week' }, { kind: 'note', text: 'The week-by-week report is unavailable right now.' }];
        await this.addLearningRows([...curveReport, ...funnelRows(funnel)]);
      }
      this.learningLoaded = true;
      log.info(`Learning report: ${funnel ? `${this.learningRowIds.length} rows` : 'unavailable'}`);
    } finally {
      if (this.learningPaneId === paneId) this.learningLoading = false;
      if (refreshId && this.learningRefreshId === refreshId) this.send(event(this.id, refreshId, 'update', { busy: false }));
    }
  }

  /** Remove every dynamic row from the pane and destroy it (a row box takes its widgets with it). */
  private async clearLearningRows(): Promise<void> {
    const paneId = this.learningPaneId;
    const rowIds = this.learningRowIds;
    this.learningRowIds = [];
    await Promise.all(rowIds.map(async (widgetId) => {
      if (paneId) {
        await this.request(request(this.id, paneId, 'removeLayoutChild', { widgetId })).catch(() => { /* pane gone */ });
      }
      await this.request(request(this.id, widgetId, 'destroy', {})).catch(() => { /* already gone */ });
    }));
    ensure(this.learningRowIds.length === 0, 'no report rows remain after clearing');
  }

  /**
   * Append report rows to the pane: a heading or note is one label; a stat is
   * a row box of label, optional share bar, and right-aligned value. Every
   * widget is created in one batch.
   */
  private async addLearningRows(rows: ReportRow[]): Promise<void> {
    const paneId = this.learningPaneId, windowId = this.windowId, wm = this.widgetManagerId;
    if (!paneId || !windowId || !wm || rows.length === 0) return;

    const specs: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (row.kind === 'heading') {
        specs.push({ type: 'label', windowId, text: sectionHeaderText(this.theme, row.text),
          style: { ...sectionHeaderStyle(this.theme, 12), wordWrap: false } });
      } else if (row.kind === 'note') {
        specs.push({ type: 'label', windowId, text: row.text,
          style: { fontSize: 11, color: this.theme.textSecondary, ...(row.lines && row.lines > 1 ? { wordWrap: true } : {}) } });
      } else if (row.kind === 'table') {
        specs.push({ type: 'table', windowId, sortable: false, columns: row.columns, rowsData: row.rows, rowHeight: TABLE_ROW_H });
      } else {
        specs.push({ type: 'label', windowId, text: row.label, style: { fontSize: 12, color: this.theme.textPrimary } });
        if (row.ratio !== undefined) specs.push({ type: 'progress', windowId, value: row.ratio });
        specs.push({ type: 'label', windowId, text: row.value,
          style: { fontSize: 12, fontWeight: 'bold', color: this.theme.textHeading, align: 'right' } });
      }
    }
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, wm, 'create', { specs }));

    // Hand each row its widgets, in creation order.
    const placed: Array<{ row: ReportRow; ids: AbjectId[] }> = [];
    let next = 0;
    for (const row of rows) {
      const n = row.kind === 'stat' ? (row.ratio !== undefined ? 3 : 2) : 1;
      placed.push({ row, ids: widgetIds.slice(next, next + n) });
      next += n;
    }
    ensure(next === widgetIds.length, 'every created widget belongs to one report row');

    const fixedRow = (widgetId: AbjectId, height: number) => ({
      widgetId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height },
    });
    const children = await Promise.all(placed.map(async ({ row, ids }) => {
      if (row.kind === 'table') return fixedRow(ids[0], TABLE_HEADER_H + row.rows.length * TABLE_ROW_H + 4);
      if (row.kind === 'note') return fixedRow(ids[0], REPORT_ROW_H + Math.max(0, (row.lines ?? 1) - 1) * 15);
      if (row.kind !== 'stat') return fixedRow(ids[0], 28);
      const rowId = await this.request<AbjectId>(request(this.id, wm, 'createDetachedHBox', {
        windowId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 12,
      }));
      const [labelId, ...rest] = ids;
      const barId = row.ratio !== undefined ? rest[0] : undefined;
      const valueId = rest[rest.length - 1];
      await this.request(request(this.id, rowId, 'addLayoutChildren', {
        children: [
          { widgetId: labelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: REPORT_ROW_H } },
          ...(barId ? [{ widgetId: barId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: REPORT_BAR_W, height: 8 } }] : []),
          { widgetId: valueId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: REPORT_VALUE_W, height: REPORT_ROW_H } },
        ],
      }));
      return fixedRow(rowId, REPORT_ROW_H);
    }));

    // Recorded before attaching, so a failure part way still clears them next time.
    this.learningRowIds.push(...children.map(c => c.widgetId));
    await this.request(request(this.id, paneId, 'addLayoutChildren', { children }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event handling
  // ═══════════════════════════════════════════════════════════════════

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Tab changed
    if (fromId === this.tabBarId && aspect === 'change') {
      const idx = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!isNaN(idx) && idx >= 0 && idx < TAB_LABELS.length) {
        this.activeTab = idx;
        this.selectedId = undefined;
        this.selectedPage = undefined;
        this.graphMapId = undefined;
        await this.showEmptyState(true);
        if (this.searchInputId) {
          this.send(event(this.id, this.searchInputId, 'update', {
            placeholder: idx === MAPS_TAB ? 'Search maps...' : 'Search knowledge...',
          }));
        }
        await this.reloadList();
        await this.updateGraphPane();
        await this.syncLearningPane();
      }
      return;
    }

    // Learning tab: re-read the funnel
    if (fromId === this.learningRefreshId && aspect === 'click') {
      await this.loadLearning();
      return;
    }

    // Search input changed -- full-text search via KnowledgeBase recall
    // (DocumentMap search on the Maps tab)
    if (fromId === this.searchInputId && aspect === 'change') {
      this.searchQuery = typeof value === 'string' ? value : '';
      this.selectedId = undefined;
      this.selectedPage = undefined;
      await this.showEmptyState(true);
      await this.reloadList();
      return;
    }

    // Show-archived toggle. CheckboxWidget emits the string 'true'/'false',
    // not a boolean; accept both shapes.
    if (fromId === this.archivedToggleId && aspect === 'change') {
      this.showArchived = value === true || value === 'true';
      this.selectedId = undefined;
      await this.showEmptyState(true);
      await this.loadEntries();
      return;
    }

    // Curate button -- ask the reviewer to run a curation pass
    if (fromId === this.curateBtnId && aspect === 'click') {
      await this.runCurate();
      return;
    }

    // Restore button -- un-archive the selected entry
    if (fromId === this.restoreBtnId && aspect === 'click') {
      if (!this.selectedId || !this.knowledgeBaseId) return;

      const entry = this.filteredEntries.find(e => e.id === this.selectedId);
      if (entry && this.isRemoteEntry(entry)) {
        this.playEffect('shake');
        await this.notify('This entry belongs to another peer and is read-only here.', 'warning');
        return;
      }
      const restoreId = this.selectedId;
      this.send(event(this.id, this.restoreBtnId, 'update', { busy: true }));
      try {
        const res = await this.request<{ success?: boolean; error?: string }>(
          request(this.id, this.knowledgeBaseId, 'archive', { id: restoreId, archived: false })
        );
        if (res && res.success === false) {
          throw new Error(res.error ?? 'entry no longer exists');
        }
        this.recordArchiveStep(entry ? `Restore ${entry.title}` : 'Restore entry',
          { id: restoreId, title: entry?.title ?? 'entry', archived: false });
        this.playEffect('flash');
        await this.notify(entry ? `Restored "${entry.title}"` : 'Entry restored', 'success');
        await this.loadEntries();
        const restored = this.filteredEntries.find(e => e.id === this.selectedId);
        if (restored) {
          await this.showDetail(restored);
        } else {
          this.selectedId = undefined;
          await this.showEmptyState(true);
        }
      } catch (err) {
        this.playEffect('shake');
        const msg = err instanceof Error ? err.message : String(err);
        await this.notify(`Restore failed: ${msg.slice(0, 80)}`, 'error');
      } finally {
        this.send(event(this.id, this.restoreBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Link chip -- navigate to the linked pattern or map page
    if (aspect === 'click' && this.linkButtons.has(fromId)) {
      const target = this.linkButtons.get(fromId)!;
      if (target.kind === 'page') {
        await this.selectMapPage(target.map, target.page);
        return;
      }
      // Prefer the live entry (the cached one may predate an update)
      const live = this.filteredEntries.find(e => e.id === target.entry.id) ?? target.entry;
      await this.selectPattern(live);
      return;
    }

    // List selection
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const entryId = (data as { value?: string })?.value;
      if (entryId && this.activeTab === MAPS_TAB) {
        const row = this.filteredMapRows.find(r => this.mapRowKey(r.map, r.slug) === entryId);
        if (row) await this.selectMapPage(row.map, row.slug);
        return;
      }
      if (entryId) {
        this.selectedId = entryId;
        const entry = this.filteredEntries.find(e => e.id === entryId);
        if (entry) {
          await this.showDetail(entry);
          if (entry.type === 'pattern') await this.selectOnMap(entry.id);
        }
      }
      return;
    }

    // Map: a click (or double-click) on a pattern node opens it; unwritten
    // names have no entry to open.
    if (fromId === this.graphId && (aspect === 'nodeSelected' || aspect === 'nodeFocused')) {
      const data = typeof value === 'string' ? JSON.parse(value) as { id?: string } : value as { id?: string };
      const id = data?.id;
      if (!id || id.startsWith(GHOST_PREFIX)) return;
      if (this.activeTab === MAPS_TAB) {
        if (this.graphMapId && id.startsWith(PAGE_PREFIX)) await this.selectMapPage(this.graphMapId, id.slice(PAGE_PREFIX.length));
        return;
      }
      const entry = this.filteredEntries.find(e => e.id === id) ?? this.entries.find(e => e.id === id)
        ?? await this.request<KnowledgeEntry | null>(request(this.id, this.knowledgeBaseId!, 'get', { id })).catch(() => null);
      if (entry) await this.selectPattern(entry);
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      if (!this.selectedId || !this.knowledgeBaseId) return;

      const entry = this.filteredEntries.find(e => e.id === this.selectedId);
      if (entry && this.isRemoteEntry(entry)) {
        this.playEffect('shake');
        await this.notify('This entry belongs to another peer and is read-only here.', 'warning');
        return;
      }
      // Forgetting is two-step. A live entry is archived: out of recall and
      // the default list, but kept, and Ctrl+Z (or Restore) brings it back,
      // so it needs no dialog. An archived entry is deleted for good, learning
      // history included, and its tombstone reaches peers: that asks first.
      // Whether it is archived is read fresh, so a stale list never deletes
      // without asking.
      const selectedId = this.selectedId;
      const fresh = await this.request<KnowledgeEntry | null>(
        request(this.id, this.knowledgeBaseId, 'get', { id: selectedId })).catch(() => null);
      const deleting = (fresh ?? entry)?.archived === true;
      const title = fresh?.title ?? entry?.title;
      const name = title ? `"${title}"` : 'This entry';
      if (deleting) {
        const confirmed = await this.confirm({
          title: 'Delete this knowledge for good?',
          message: `${name} is archived and will be permanently removed, along with everything learned from it.`,
          confirmLabel: 'Delete',
          destructive: true,
        });
        if (!confirmed) return;
      }

      this.send(event(this.id, this.deleteBtnId, 'update', { busy: true }));
      try {
        const res = await this.request<{ success?: boolean; archived?: boolean; deleted?: boolean; error?: string }>(
          request(this.id, this.knowledgeBaseId, 'forget', { id: selectedId })
        );
        if (res && res.success === false) {
          throw new Error(res.error ?? 'entry no longer exists');
        }
        if (!res?.deleted) {
          this.recordArchiveStep(title ? `Forget ${title}` : 'Forget entry', { id: selectedId, title: title ?? 'entry', archived: true });
        }
        await this.notify(
          res?.deleted ? `Deleted ${name}` : `Forgot ${name}: archived. Ctrl+Z to undo`,
          'success',
        );
        this.selectedId = undefined;
        await this.showEmptyState(true);
        await this.loadEntries();
      } catch (err) {
        this.playEffect('shake');
        const msg = err instanceof Error ? err.message : String(err);
        await this.notify(`Forget failed: ${msg.slice(0, 80)}`, 'error');
      } finally {
        this.send(event(this.id, this.deleteBtnId, 'update', { busy: false }));
      }
      return;
    }

    // DocumentMap events: a page written, flagged or archived, or a map made or removed
    if (fromId === this.documentMapId && (aspect === 'pageChanged' || aspect === 'mapsChanged')) {
      await this.mapsChanged(aspect, value);
      return;
    }

    // KnowledgeBase events
    if (fromId === this.knowledgeBaseId) {
      if (aspect === 'entryAdded' || aspect === 'entryUpdated' || aspect === 'entryRemoved') {
        // New knowledge saved (by an agent, the reviewer or curation) arrives
        // in the living light; a burst of saves reads as one flash.
        if (aspect === 'entryAdded' && Date.now() - this.lastArrivalFlashAt >= ARRIVAL_FLASH_GAP_MS) {
          this.lastArrivalFlashAt = Date.now();
          this.playEffect('flash');
        }
        await this.loadEntries();
        if (this.graphActive() && TAB_TYPES[this.activeTab] === 'pattern') {
          await this.loadGraph();
          const added = value as { id?: string; type?: string } | undefined;
          if (aspect === 'entryAdded' && added?.type === 'pattern' && added.id) await this.pulseNode(added.id);
        }
        if (this.selectedId && aspect === 'entryUpdated') {
          const entry = this.filteredEntries.find(e => e.id === this.selectedId);
          if (entry) await this.showDetail(entry);
        }
        if (this.selectedId && aspect === 'entryRemoved') {
          const data = value as { id?: string } | undefined;
          if (data?.id === this.selectedId) {
            this.selectedId = undefined;
            await this.showEmptyState(true);
          }
        }
      }
      return;
    }
  }

  // ── Undo ───────────────────────────────────────────────────────────

  private recordArchiveStep(label: string, step: { id: string; title: string; archived: boolean }): void {
    this.archiveSteps.record(label, step);
    this.changed('undoStateChanged', this.archiveSteps.state());
  }

  /**
   * Undo or redo an archiving made here with the opposite `archive` message.
   * The entry must still be in the state the step left it in: one archived,
   * restored or deleted since (by curation, an agent, a peer) is left alone.
   */
  private async undoArchive(action: UndoAction): Promise<unknown> {
    const result = await this.archiveSteps[action](async (step) => {
      const kb = this.knowledgeBaseId;
      if (!kb) throw new Error('KnowledgeBase not available');
      const { id, title, archived } = step.data;
      const left = action === 'undo' ? archived : !archived;
      const entry = await this.request<KnowledgeEntry | null>(request(this.id, kb, 'get', { id })).catch(() => null);
      if (!entry) throw new UndoRefused(`"${title}" is gone`);
      if (entry.archived !== left) throw new UndoRefused(`"${title}" was ${entry.archived ? 'archived' : 'restored'} since`);
      const res = await this.request<{ success?: boolean; error?: string }>(
        request(this.id, kb, 'archive', { id, archived: !left }));
      if (res && res.success === false) throw new UndoRefused(res.error ?? `"${title}" no longer exists`);
    });
    this.changed('undoStateChanged', this.archiveSteps.state());
    if (result.ok && this.windowId) {
      await this.loadEntries();
      const shown = this.selectedId ? this.filteredEntries.find(e => e.id === this.selectedId) : undefined;
      if (shown) {
        await this.showDetail(shown);
      } else if (this.selectedId) {
        this.selectedId = undefined;
        await this.showEmptyState(true);
      }
    }
    return result;
  }
}

export const KNOWLEDGE_BROWSER_ID = 'abjects:knowledge-browser' as AbjectId;
