/**
 * goal-tree — shared, UI-agnostic row model for showing goals.
 *
 * Chat's live goal card and the Goals window draw the same things: a goal's
 * state, the planner's latest word, what each task is doing step by step, and
 * what finished work produced. This module owns turning goals, their tasks and
 * their progress log into flat display rows, so the two surfaces never drift.
 * It emits full text and abstract colour roles; GoalProgressWidget resolves
 * the roles to theme colours, wraps the text and measures it.
 *
 * Two builders:
 *   buildGoalDetailRows — one goal as a card (header, question, planner line,
 *     rounds of tasks with a step trail under running work, result, notes).
 *   buildGoalListRows   — the Goals window's list (needs you, running, then
 *     finished goals by day), one selectable row per goal.
 */

import type { IconName } from '../ui/icons.js';
import { require } from '../core/contracts.js';
import { orderTopologically, blockedOn, indexById, isTerminal } from '../core/task-graph.js';

export type GoalRowKind =
  | 'header' | 'headline' | 'title' | 'question' | 'planner' | 'section' | 'task' | 'step'
  | 'more' | 'next' | 'error' | 'result' | 'note' | 'footer' | 'item' | 'empty';

/**
 * Abstract colour role. The widget maps these to theme colours so the same row
 * model renders correctly under any theme. `live` is work in motion, `caution`
 * is something waiting on the person or near a limit.
 */
export type ColorRole =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'live'
  | 'caution'
  | 'success'
  | 'error'
  | 'neutral';

/** A background band behind a whole row. */
export type BandRole = 'selected' | 'caution' | 'muted';

export type GoalRowAction = 'pause' | 'resume' | 'stop';

export interface GoalRow {
  /** Unique within one build; clickable rows report it back. */
  id: string;
  kind: GoalRowKind;
  depth: number;
  /** Full text; the widget word-wraps it. */
  text: string;
  /** No icon: the text starts at the icon column. */
  iconName?: IconName;
  /** Keep the icon column empty so the text lines up under an icon row above. */
  iconSpace?: boolean;
  iconColorRole: ColorRole;
  textColorRole: ColorRole;
  /** Short text right-aligned on the first line (a step count, a time). */
  meta?: string;
  metaColorRole?: ColorRole;
  /** A name chip drawn before the text (the agent doing the work). */
  badge?: string;
  /** Smaller wrapped text under the main text. */
  detail?: string;
  detailColorRole?: ColorRole;
  /** One line of monospace under the text (a command), cut to fit. */
  code?: string;
  /** A thin progress bar under the row. */
  bar?: { fraction: number; role: ColorRole };
  /** Draw the trail line down the gutter beside this row (steps). */
  rail?: boolean;
  band?: BandRole;
  bold?: boolean;
  /** Small capitals in the display face (states, section labels). */
  display?: boolean;
  /** A click anywhere on the row reports `toggle` or `select` with this row's id. */
  click?: 'toggle' | 'select';
  /** For a toggle row: whether it is open now, so a click can flip it. */
  expanded?: boolean;
  /** Per-goal controls the widget draws right-aligned and reports as `goalAction`. */
  actions?: GoalRowAction[];
}

/** One progress line as GoalManager records it. */
export interface ProgressLike {
  timestamp: number;
  agentName: string;
  message: string;
  phase?: string;
  taskId?: string;
  step?: number;
  maxSteps?: number;
  since?: number;
  /** The step in everyday words, for the person ("Looking up Saturday's forecast"). */
  say?: string;
}

/** A task as both callers read it from GoalManager's tuples. */
export interface TaskNode {
  id: string;
  description: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  claimedBy?: string;
  agentName?: string;
  /** Task ids this one waits on. A round is a graph, not a list. */
  dependsOn?: string[];
  /** The planning round (scrum) that created it. */
  scrumNumber?: number;
  /** One line of what it produced, or why it failed. */
  result?: string;
  error?: string;
}

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed' | 'archived';

/** Everything the card shows about one goal. */
export interface GoalView {
  id: string;
  title: string;
  status: GoalStatus;
  createdAt?: number;
  updatedAt?: number;
  progress: ProgressLike[];
  tasks: TaskNode[];
  /** The question the goal paused to ask. */
  question?: string;
  error?: string;
  /** What the finished goal produced, in full. */
  result?: string;
  /** Notes the person sent while it ran. */
  notes?: Array<{ note: string; status: 'pending' | 'incorporated'; at: number }>;
  /** What the learning review kept from this goal. */
  learned?: string[];
  /** Sub-goals, one line each. */
  children?: Array<{ id: string; title: string; status: GoalStatus; latest?: string }>;
  /** Created by another peer: read-only here. */
  isRemote?: boolean;
  creatorPeerId?: string;
}

export interface DetailOptions {
  now: number;
  /** Open state of a toggled row; undefined means the default for it. */
  isOpen: (rowId: string) => boolean | undefined;
  /** 'chat' leaves out the title (the bubble shows it) and points answers below. */
  surface: 'chat' | 'browser';
  /** Draw pause/resume/stop on the header. */
  withActions?: boolean;
}

// ─── Small text and time helpers ─────────────────────────────────────

/** A duration as people say it: 0.3s, 12s, 1m 32s, 4h 51m. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A time for a list: the clock today, the weekday this week, else the date. */
export function formatWhen(ts: number, now: number): string {
  const today = startOfDay(now);
  if (ts >= today) return clock(ts);
  if (ts >= today - 6 * 86400000) return new Date(ts).toLocaleDateString([], { weekday: 'short' });
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** How long ago, in words: "just now", "14 seconds ago", "3 minutes ago". */
export function formatAgo(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'a day ago' : `${d} days ago`;
}

/** The first line of a text, stripped of markdown marks and cut at a word near `max`. */
export function oneLine(text: string, max = 160): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const plain = line.replace(/^#+\s*/, '').replace(/^[-*>]\s+/, '').replace(/\*\*|__|`/g, '').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What a result value says, as text: a string itself, else its summary or message field, else JSON. */
export function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result.trim() || undefined;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['summary', 'answer', 'message', 'result', 'text', 'output']) {
      if (typeof r[key] === 'string' && (r[key] as string).trim()) return (r[key] as string).trim();
    }
  }
  try { return JSON.stringify(result); } catch { return undefined; }
}

// ─── Step trails ─────────────────────────────────────────────────────

export interface TrailStep {
  step: number;
  /** What the agent said it was doing (its reasoning at the act). */
  title?: string;
  /** A second line the step reported: usually the command it ran. */
  command?: string;
  phase?: string;
  /** When the current phase began. */
  phaseAt: number;
  startedAt: number;
  lastAt: number;
  /** The start of the next step; absent on the last one. */
  endedAt?: number;
  /** Set while the agent waits on the person. */
  waiting?: string;
}

export interface TaskTrail {
  agentName?: string;
  steps: TrailStep[];
  maxSteps?: number;
  firstAt: number;
  lastAt: number;
}

const GENERIC_STEP = /^[a-z_]+ \(step \d+\/\d+\)$/;
const SILENT = new Set(['working...', 'working…', 'LLM thinking...']);

function buildTrail(entries: ProgressLike[]): TaskTrail {
  const steps: TrailStep[] = [];
  let cur: TrailStep | undefined;
  let maxSteps: number | undefined;
  let agentName: string | undefined;
  for (const e of entries) {
    const at = e.since ?? e.timestamp;
    agentName = e.agentName || agentName;
    if (Number.isFinite(e.maxSteps)) maxSteps = e.maxSteps;
    const stepNo = Number.isFinite(e.step) ? e.step! : cur?.step ?? 1;
    if (!cur || stepNo !== cur.step) {
      if (cur) cur.endedAt = at;
      cur = { step: stepNo, phaseAt: at, startedAt: at, lastAt: at };
      steps.push(cur);
    }
    cur.lastAt = e.timestamp;
    if (e.phase && e.phase !== cur.phase) { cur.phase = e.phase; cur.phaseAt = at; }
    if (e.phase === 'waiting_for_human') cur.waiting = e.message;
    const message = e.message.trim();
    if (!message || SILENT.has(message) || GENERIC_STEP.test(message)) continue;
    if (!cur.title) cur.title = message;
    else if (message !== cur.title && !cur.command) cur.command = message;
  }
  return {
    agentName, steps, maxSteps,
    firstAt: entries.length ? (entries[0].since ?? entries[0].timestamp) : 0,
    lastAt: entries.length ? entries[entries.length - 1].timestamp : 0,
  };
}

const RUNNING = new Set(['claimed', 'in_progress']);
const DROPPED = new Set(['superseded', 'cancelled']);

/**
 * A task is running once it is claimed, or once its agent reports on it: a
 * task pushed straight to an agent stays pending in the TupleSpace until it
 * settles, so its own progress lines are what say it started.
 */
function isRunning(task: TaskNode, reported: ReadonlySet<string>): boolean {
  return RUNNING.has(task.status) || (task.status === 'pending' && (!!task.claimedBy || reported.has(task.id)));
}

/** Tasks that have progress lines of their own. */
function reportedTasks(progress: ProgressLike[]): Set<string> {
  const ids = new Set<string>();
  for (const e of progress) if (e.taskId) ids.add(e.taskId);
  return ids;
}

/**
 * File every progress line under the task it reports on. A line that names
 * its task goes there. A line that names none (an agent's own report, such as
 * the command it is running) goes to the one running task its agent holds;
 * anything else is the planner's.
 */
export function attributeProgress(view: Pick<GoalView, 'progress' | 'tasks'>): {
  trails: Map<string, TaskTrail>;
  planner?: ProgressLike;
  reported: Set<string>;
} {
  const reported = reportedTasks(view.progress);
  const byTask = new Map<string, ProgressLike[]>();
  const taskIds = new Set(view.tasks.map(t => t.id));
  const agentOf = new Map<string, string>();
  for (const t of view.tasks) if (t.agentName) agentOf.set(t.id, t.agentName);
  for (const e of view.progress) {
    if (e.taskId && taskIds.has(e.taskId)) agentOf.set(e.taskId, e.agentName);
  }
  let planner: ProgressLike | undefined;
  for (const e of view.progress) {
    let taskId = e.taskId && taskIds.has(e.taskId) ? e.taskId : undefined;
    if (!taskId) {
      const held = view.tasks.filter(t => agentOf.get(t.id) === e.agentName
        && (isRunning(t, reported) || (byTask.get(t.id)?.at(-1)?.timestamp ?? -Infinity) >= e.timestamp - 60000));
      if (held.length === 1) taskId = held[0].id;
    }
    if (!taskId) {
      // The planner's own step lines ("done (step 1/12)") say nothing; keep its last sentence.
      const said = e.message.trim();
      if (said && !SILENT.has(said) && !GENERIC_STEP.test(said)) planner = e;
      continue;
    }
    const list = byTask.get(taskId) ?? [];
    list.push(e);
    byTask.set(taskId, list);
  }
  const trails = new Map<string, TaskTrail>();
  for (const [id, entries] of byTask) trails.set(id, buildTrail(entries));
  return { trails, planner, reported };
}

// ─── The card ────────────────────────────────────────────────────────

const STEPS_SHOWN = 4;
const LONG_THINK_MS = 30000;

function stateOf(view: GoalView): { label: string; role: ColorRole } {
  if (view.question && (view.status === 'paused' || view.status === 'active')) return { label: 'WAITING ON YOU', role: 'caution' };
  switch (view.status) {
    case 'active': return { label: 'WORKING', role: 'live' };
    case 'paused': return { label: 'PAUSED', role: 'neutral' };
    case 'completed': return { label: 'DONE', role: 'success' };
    case 'failed': return { label: 'FAILED', role: 'error' };
    default: return { label: 'ARCHIVED', role: 'neutral' };
  }
}

function currentStepLabel(step: TrailStep): string {
  if (step.waiting) return step.waiting;
  switch (step.phase) {
    case 'thinking':
    case 'streaming': return 'Thinking';
    case 'observing': return 'Reading the result';
    case 'acting': return step.title ?? 'Acting';
    default: return step.title ?? 'Working';
  }
}

function taskTitle(task: TaskNode): string {
  return oneLine(task.description, 180) || task.id.slice(0, 8);
}

function taskSummary(trail: TaskTrail | undefined, agentName: string | undefined): string | undefined {
  const parts: string[] = [];
  if (agentName) parts.push(agentName);
  if (trail && trail.steps.length > 0) {
    const n = trail.steps[trail.steps.length - 1].step;
    parts.push(`${n} step${n === 1 ? '' : 's'}`);
    if (trail.lastAt > trail.firstAt) parts.push(formatDuration(trail.lastAt - trail.firstAt));
  }
  return parts.length ? parts.join(' · ') : undefined;
}

function stepRows(
  rows: GoalRow[], task: TaskNode, trail: TaskTrail, depth: number, live: boolean, opts: DetailOptions,
): void {
  const steps = trail.steps;
  const allId = `steps:${task.id}`;
  const showAll = opts.isOpen(allId) === true;
  const hidden = showAll ? 0 : Math.max(0, steps.length - STEPS_SHOWN);
  if (hidden > 0) {
    rows.push({
      id: allId, kind: 'more', depth, rail: true, click: 'toggle', expanded: false,
      text: `Show ${hidden} earlier step${hidden === 1 ? '' : 's'}`,
      iconName: 'chevronRight', iconColorRole: 'tertiary', textColorRole: 'live',
    });
  } else if (showAll && steps.length > STEPS_SHOWN) {
    rows.push({
      id: allId, kind: 'more', depth, rail: true, click: 'toggle', expanded: true,
      text: 'Show only the latest steps',
      iconName: 'chevronDown', iconColorRole: 'tertiary', textColorRole: 'live',
    });
  }
  const recentCommands = steps.map(s => s.command);
  for (let i = hidden; i < steps.length; i++) {
    const s = steps[i];
    const last = i === steps.length - 1;
    if (last && live) {
      const elapsed = opts.now - s.phaseAt;
      const thinking = s.phase === 'thinking' || s.phase === 'streaming';
      rows.push({
        id: `step:${task.id}:${s.step}`, kind: 'step', depth, rail: true,
        text: currentStepLabel(s),
        iconName: 'dot', iconColorRole: s.waiting ? 'caution' : 'live',
        textColorRole: 'primary', bold: true,
        meta: formatDuration(elapsed), metaColorRole: s.waiting ? 'caution' : 'live',
        ...(s.phase === 'acting' && s.command ? { code: s.command } : {}),
        ...(thinking && elapsed > LONG_THINK_MS
          ? { detail: 'Waiting on the model. A long prompt can take minutes; Kill is in the LLM monitor.', detailColorRole: 'tertiary' as ColorRole }
          : {}),
      });
      continue;
    }
    const repeated = !!s.command && recentCommands.slice(Math.max(0, i - 3), i).includes(s.command);
    const duration = (s.endedAt ?? s.lastAt) - s.startedAt;
    rows.push({
      id: `step:${task.id}:${s.step}`, kind: 'step', depth, rail: true,
      text: s.title ?? `Step ${s.step}`,
      iconName: repeated ? 'warning' : 'check', iconColorRole: repeated ? 'caution' : 'tertiary',
      textColorRole: 'secondary',
      ...(duration > 0 ? { meta: formatDuration(duration), metaColorRole: 'tertiary' as ColorRole } : {}),
      ...(s.command ? { code: s.command } : {}),
      ...(repeated ? { detail: 'Same command as a few steps ago', detailColorRole: 'caution' as ColorRole } : {}),
    });
  }
}

function taskRows(
  rows: GoalRow[], tasks: TaskNode[], trails: Map<string, TaskTrail>, reported: ReadonlySet<string>,
  depth: number, opts: DetailOptions, goalLive: boolean,
): void {
  const byId = indexById(tasks);
  const label = (id: string): string => {
    const dep = byId.get(id);
    return dep ? oneLine(dep.description, 40) : id.slice(0, 8);
  };
  for (const task of orderTopologically(tasks)) {
    const trail = trails.get(task.id);
    const agent = trail?.agentName ?? task.agentName;
    const running = goalLive && isRunning(task, reported);
    const rowId = `task:${task.id}`;

    if (running) {
      const last = trail?.steps[trail.steps.length - 1];
      const max = trail?.maxSteps;
      const open = opts.isOpen(rowId) ?? true;
      // The step limit is a ceiling, not an estimate of the work, so it shows only near the end.
      const nearLimit = !!last && !!max && max - last.step <= Math.max(1, Math.round(max * 0.2));
      rows.push({
        id: rowId, kind: 'task', depth, click: 'toggle', expanded: open,
        text: taskTitle(task), bold: true,
        ...(agent ? { badge: agent } : {}),
        iconName: open ? 'chevronDown' : 'chevronRight', iconColorRole: 'live', textColorRole: 'primary',
        ...(last ? {
          meta: nearLimit && max ? `step ${last.step} of ${max} · ${Math.max(0, max - last.step)} left` : `step ${last.step}`,
          metaColorRole: nearLimit ? 'caution' as ColorRole : 'tertiary' as ColorRole,
        } : {}),
      });
      if (open && trail && trail.steps.length > 0) stepRows(rows, task, trail, depth + 1, true, opts);
      continue;
    }

    if (task.status === 'done' || task.status === 'permanently_failed' || task.status === 'failed') {
      const failed = task.status !== 'done';
      const open = opts.isOpen(rowId) === true;
      const said = failed ? task.error : task.result;
      rows.push({
        id: rowId, kind: 'task', depth, ...(trail?.steps.length ? { click: 'toggle' as const, expanded: open } : {}),
        text: taskTitle(task),
        iconName: failed ? 'close' : 'check', iconColorRole: failed ? 'error' : 'success',
        textColorRole: 'primary',
        ...(taskSummary(trail, agent) ? { meta: taskSummary(trail, agent), metaColorRole: 'tertiary' as ColorRole } : {}),
        ...(said ? { detail: oneLine(said, 220), detailColorRole: failed ? 'error' as ColorRole : 'secondary' as ColorRole } : {}),
      });
      if (open && trail && trail.steps.length > 0) stepRows(rows, task, trail, depth + 1, false, opts);
      continue;
    }

    if (DROPPED.has(task.status)) {
      rows.push({
        id: rowId, kind: 'task', depth,
        text: taskTitle(task),
        iconName: 'close', iconColorRole: 'neutral', textColorRole: 'tertiary',
        meta: task.status === 'superseded' ? 'replaced' : 'cancelled', metaColorRole: 'tertiary',
      });
      continue;
    }

    // Waiting: on other work, or for a free agent.
    const waiting = blockedOn(task, byId);
    rows.push({
      id: rowId, kind: 'next', depth,
      text: taskTitle(task),
      ...(agent ? { badge: agent } : {}),
      iconName: 'clock', iconColorRole: 'tertiary', textColorRole: 'secondary',
      meta: !goalLive ? 'not started' : waiting.length > 0 ? 'waiting' : 'queued',
      metaColorRole: 'tertiary',
      ...(goalLive && waiting.length > 0 ? { detail: `After: ${waiting.map(label).join(', ')}`, detailColorRole: 'tertiary' as ColorRole } : {}),
    });
  }
}

function roundSummary(tasks: TaskNode[]): string {
  const done = tasks.filter(t => t.status === 'done').length;
  const failed = tasks.filter(t => t.status === 'permanently_failed' || t.status === 'failed').length;
  const dropped = tasks.filter(t => DROPPED.has(t.status)).length;
  const parts = [`${done} done`];
  if (failed) parts.push(`${failed} failed`);
  if (dropped) parts.push(`${dropped} replaced`);
  return parts.join(' · ');
}

/** One goal as a card. */
export function buildGoalDetailRows(view: GoalView, opts: DetailOptions): GoalRow[] {
  const rows: GoalRow[] = [];
  const live = view.status === 'active' || view.status === 'paused';
  const state = stateOf(view);
  const { trails, planner, reported } = attributeProgress(view);

  // Header: state, round, elapsed, tasks done.
  const rounds = [...new Set(view.tasks.map(t => t.scrumNumber ?? 0))].sort((a, b) => a - b);
  const round = rounds.length ? rounds[rounds.length - 1] : 0;
  const doneCount = view.tasks.filter(t => t.status === 'done').length;
  const failedCount = view.tasks.filter(t => t.status === 'permanently_failed' || t.status === 'failed').length;
  const counted = view.tasks.filter(t => !DROPPED.has(t.status)).length;
  const metaParts: string[] = [];
  if (round > 0) metaParts.push(`Round ${round}`);
  if (view.createdAt) {
    const end = live ? opts.now : (view.updatedAt ?? opts.now);
    metaParts.push(view.status === 'paused' && view.updatedAt
      ? `paused ${formatDuration(opts.now - view.updatedAt)}`
      : formatDuration(end - view.createdAt));
  }
  if (counted > 0) {
    metaParts.push(failedCount > 0 ? `${doneCount} done · ${failedCount} failed` : `${doneCount} of ${counted} tasks done`);
  }
  const actions: GoalRowAction[] | undefined = !opts.withActions || view.isRemote ? undefined
    : view.status === 'active' ? ['pause', 'stop']
    : view.status === 'paused' ? ['resume', 'stop']
    : undefined;
  rows.push({
    id: `header:${view.id}`, kind: 'header', depth: 0,
    text: view.isRemote ? `${state.label} · ${remoteBadge(view.creatorPeerId)}` : state.label,
    display: true,
    iconName: 'dot', iconColorRole: state.role, textColorRole: state.role,
    ...(metaParts.length ? { meta: metaParts.join(' · '), metaColorRole: 'tertiary' as ColorRole } : {}),
    ...(actions ? { actions } : {}),
  });
  if (opts.surface === 'browser') {
    rows.push({ id: `title:${view.id}`, kind: 'title', depth: 0, text: view.title, bold: true, iconColorRole: 'primary', textColorRole: 'primary' });
  }

  // The question the goal waits on.
  if (view.question && live) {
    rows.push({
      id: `question:${view.id}`, kind: 'question', depth: 0, band: 'caution',
      text: view.question,
      iconName: 'help', iconColorRole: 'caution', textColorRole: 'primary',
      detail: opts.surface === 'chat' ? 'Reply below. Your answer resumes the goal.' : 'Answer it in the conversation the goal came from.',
      detailColorRole: 'caution',
    });
  }

  // The planner's latest word, while the goal runs.
  if (planner && live && !view.question) {
    rows.push({
      id: `planner:${view.id}`, kind: 'planner', depth: 0, band: 'muted',
      text: planner.message,
      iconName: 'chat', iconColorRole: 'secondary', textColorRole: 'secondary',
      detail: `${planner.agentName} · ${clock(planner.timestamp)}`, detailColorRole: 'tertiary',
    });
  }

  if (view.status === 'failed' && view.error) {
    rows.push({
      id: `error:${view.id}`, kind: 'error', depth: 0,
      text: view.error,
      iconName: 'close', iconColorRole: 'error', textColorRole: 'error',
    });
  }

  // Rounds: the last two open, older ones folded into one line.
  const byRound = new Map<number, TaskNode[]>();
  for (const t of view.tasks) {
    const r = t.scrumNumber ?? 0;
    const list = byRound.get(r) ?? [];
    list.push(t);
    byRound.set(r, list);
  }
  const shown = rounds.slice(-2);
  const folded = rounds.slice(0, -2);
  if (folded.length > 0) {
    const foldId = `rounds:${view.id}`;
    const open = opts.isOpen(foldId) === true;
    const all = folded.flatMap(r => byRound.get(r) ?? []);
    const span = folded.length === 1 ? `Round ${folded[0]}` : `Rounds ${folded[0]} to ${folded[folded.length - 1]}`;
    rows.push({
      id: foldId, kind: 'more', depth: 0, click: 'toggle', expanded: open,
      text: `${span} · ${roundSummary(all)}`,
      iconName: open ? 'chevronDown' : 'chevronRight', iconColorRole: 'tertiary', textColorRole: 'secondary',
    });
    if (open) for (const r of folded) {
      rows.push({ id: `round:${view.id}:${r}`, kind: 'section', depth: 1, text: `ROUND ${r}`, display: true, iconColorRole: 'tertiary', textColorRole: 'tertiary' });
      taskRows(rows, byRound.get(r) ?? [], trails, reported, 1, opts, live);
    }
  }
  for (const r of shown) {
    if (rounds.length > 1) {
      rows.push({ id: `round:${view.id}:${r}`, kind: 'section', depth: 0, text: `ROUND ${r}`, display: true, iconColorRole: 'tertiary', textColorRole: 'tertiary' });
    }
    taskRows(rows, byRound.get(r) ?? [], trails, reported, 0, opts, live);
  }

  for (const child of view.children ?? []) {
    rows.push({
      id: `child:${child.id}`, kind: 'task', depth: 0,
      text: `Sub-goal: ${child.title}`,
      iconName: child.status === 'completed' ? 'check' : child.status === 'failed' ? 'close' : 'chevronRight',
      iconColorRole: child.status === 'completed' ? 'success' : child.status === 'failed' ? 'error' : 'live',
      textColorRole: 'primary',
      ...(child.latest ? { detail: child.latest, detailColorRole: 'tertiary' as ColorRole } : {}),
    });
  }

  if (live && view.tasks.length === 0 && !view.question) {
    rows.push({
      id: `empty:${view.id}`, kind: 'empty', depth: 0,
      text: planner ? 'Planning the first tasks' : 'Waiting for the planner',
      iconName: 'clock', iconColorRole: 'tertiary', textColorRole: 'tertiary',
    });
  }

  // What the finished goal produced.
  if (view.status === 'completed' && view.result) {
    rows.push({ id: `section:result:${view.id}`, kind: 'section', depth: 0, text: 'RESULT', display: true, iconColorRole: 'tertiary', textColorRole: 'tertiary' });
    rows.push({ id: `result:${view.id}`, kind: 'result', depth: 0, band: 'muted', text: view.result, iconColorRole: 'primary', textColorRole: 'primary' });
  }

  if (opts.surface === 'browser' && view.notes && view.notes.length > 0) {
    rows.push({ id: `section:notes:${view.id}`, kind: 'section', depth: 0, text: 'YOUR NOTES', display: true, iconColorRole: 'tertiary', textColorRole: 'tertiary' });
    view.notes.forEach((n, i) => rows.push({
      id: `note:${view.id}:${i}`, kind: 'note', depth: 0,
      text: `“${n.note}”`,
      iconName: 'chat', iconColorRole: 'secondary', textColorRole: 'secondary',
      meta: clock(n.at), metaColorRole: 'tertiary',
      detail: n.status === 'incorporated' ? 'Weighed by the planner' : 'Waiting for the planner to read it',
      detailColorRole: 'tertiary',
    }));
  }

  if (view.learned && view.learned.length > 0) {
    rows.push({ id: `section:learned:${view.id}`, kind: 'section', depth: 0, text: 'LEARNED FROM THIS GOAL', display: true, iconColorRole: 'tertiary', textColorRole: 'tertiary' });
    view.learned.forEach((l, i) => rows.push({
      id: `learned:${view.id}:${i}`, kind: 'note', depth: 0,
      text: l, iconName: 'brain', iconColorRole: 'secondary', textColorRole: 'secondary',
    }));
  }

  // Freshness.
  const lastAt = view.progress.length ? view.progress[view.progress.length - 1].timestamp : view.updatedAt;
  if (live && lastAt) {
    rows.push({
      id: `footer:${view.id}`, kind: 'footer', depth: 0,
      text: view.status === 'paused' ? 'Nothing runs while the goal waits' : `Last activity ${formatDuration(opts.now - lastAt)} ago`,
      iconColorRole: 'tertiary', textColorRole: 'tertiary',
    });
  }
  return rows;
}

// ─── The chat card ───────────────────────────────────────────────────

/** One step of the work as the person reads it: what was said, and when it began. */
interface StoryStep {
  text: string;
  at: number;
  agentName: string;
}

/** The `say` lines in the order they came, a repeat folded into the line before it. */
function storyOf(progress: ProgressLike[]): StoryStep[] {
  const steps: StoryStep[] = [];
  for (const e of progress) {
    const said = e.say ? oneLine(e.say, 160) : '';
    if (!said) continue;
    if (steps.length > 0 && steps[steps.length - 1].text === said) continue;
    steps.push({ text: said, at: e.since ?? e.timestamp, agentName: e.agentName });
  }
  return steps;
}

/** Who is doing the work now: the agents of running tasks, else whoever spoke last. */
function workersOf(view: Pick<GoalView, 'progress' | 'tasks'>): string[] {
  const { reported } = attributeProgress(view);
  const running = new Set(view.tasks.filter(t => isRunning(t, reported)).map(t => t.id));
  const names: string[] = [];
  for (let i = view.progress.length - 1; i >= 0 && names.length < 3; i--) {
    const e = view.progress[i];
    if (e.taskId && running.has(e.taskId) && !names.includes(e.agentName)) names.push(e.agentName);
  }
  if (names.length === 0 && view.progress.length > 0) names.push(view.progress[view.progress.length - 1].agentName);
  return names;
}

const STORY_SHOWN = 6;

/**
 * A running goal as Chat shows it: one sentence of what it is doing now, in
 * everyday words, with the steps so far behind "Show details". The Goals
 * window keeps the full card (`buildGoalDetailRows`).
 */
export function buildGoalChatRows(view: GoalView, opts: Pick<DetailOptions, 'now' | 'isOpen'>): GoalRow[] {
  require(typeof view.id === 'string' && view.id.length > 0, 'buildGoalChatRows needs a goal id');
  const rows: GoalRow[] = [];
  const story = storyOf(view.progress);
  const last = story[story.length - 1];
  const waiting = !!view.question && (view.status === 'active' || view.status === 'paused');
  const paused = !waiting && view.status === 'paused';

  const headline = waiting ? 'Waiting for your answer'
    : paused ? 'Paused. Resume when you are ready.'
    : last?.text ?? `Working on ${view.title}`;
  const started = view.createdAt ?? story[0]?.at;
  rows.push({
    id: `headline:${view.id}`, kind: 'headline', depth: 0,
    text: headline,
    iconName: 'dot', iconColorRole: waiting ? 'caution' : paused ? 'neutral' : 'live',
    textColorRole: 'primary',
    ...(started ? { detail: `Started ${formatAgo(opts.now - started)}`, detailColorRole: 'tertiary' as ColorRole } : {}),
  });

  const detailsId = `details:${view.id}`;
  const open = opts.isOpen(detailsId) ?? false;
  rows.push({
    id: detailsId, kind: 'more', depth: 0, iconSpace: true,
    text: open ? 'Hide details' : 'Show details',
    iconColorRole: 'live', textColorRole: 'live',
    click: 'toggle', expanded: open,
  });
  if (!open) return rows;

  if (story.length === 0) {
    rows.push({
      id: `story-empty:${view.id}`, kind: 'empty', depth: 1,
      text: 'The steps show here as the work goes.',
      iconColorRole: 'tertiary', textColorRole: 'tertiary',
    });
  }
  const earlierId = `story-earlier:${view.id}`;
  const showAll = opts.isOpen(earlierId) ?? false;
  const hidden = showAll ? 0 : Math.max(0, story.length - STORY_SHOWN);
  if (hidden > 0) {
    rows.push({
      id: earlierId, kind: 'more', depth: 1,
      text: `Show ${hidden} earlier step${hidden === 1 ? '' : 's'}`,
      iconName: 'chevronRight', iconColorRole: 'tertiary', textColorRole: 'tertiary',
      click: 'toggle', expanded: false,
    });
  }
  const moving = view.status === 'active' && !waiting;
  story.forEach((step, i) => {
    if (i < hidden) return;
    const current = moving && i === story.length - 1;
    const end = i + 1 < story.length ? story[i + 1].at : opts.now;
    rows.push({
      id: `story:${view.id}:${i}`, kind: 'step', depth: 1,
      text: step.text,
      iconName: current ? 'dot' : 'check',
      iconColorRole: current ? 'live' : 'success',
      textColorRole: current ? 'primary' : 'secondary',
      meta: formatDuration(Math.max(0, end - step.at)),
      metaColorRole: current ? 'live' : 'tertiary',
    });
  });

  const workers = workersOf(view);
  if (workers.length > 0) {
    const who = workers.length === 1 ? workers[0] : `${workers.slice(0, -1).join(', ')} and ${workers[workers.length - 1]}`;
    rows.push({
      id: `workers:${view.id}`, kind: 'footer', depth: 1,
      text: `${who} ${workers.length === 1 ? 'is' : 'are'} on it`,
      iconColorRole: 'tertiary', textColorRole: 'tertiary',
    });
  }
  rows.push({
    id: `open-goals:${view.id}`, kind: 'footer', depth: 1,
    text: 'Open in Goals',
    iconColorRole: 'live', textColorRole: 'live',
    click: 'select',
  });
  return rows;
}

// ─── The list ────────────────────────────────────────────────────────

export interface GoalListItem {
  id: string;
  title: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  question?: string;
  /** What it is doing now, or what it produced, or why it failed. */
  line?: string;
  isRemote?: boolean;
  creatorPeerId?: string;
}

export type GoalFilter = 'all' | 'running' | 'needs' | 'failed';

export function needsPerson(item: Pick<GoalListItem, 'status' | 'question'>): boolean {
  return !!item.question && (item.status === 'paused' || item.status === 'active');
}

export function matchesFilter(item: GoalListItem, filter: GoalFilter, query: string): boolean {
  if (filter === 'running' && !(item.status === 'active' || item.status === 'paused')) return false;
  if (filter === 'needs' && !needsPerson(item)) return false;
  if (filter === 'failed' && item.status !== 'failed') return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return item.title.toLowerCase().includes(q) || (item.line ?? '').toLowerCase().includes(q);
}

/** The Goals window's list: needs you, running, then finished goals by day. */
export function buildGoalListRows(items: GoalListItem[], opts: { now: number; selectedId?: string }): GoalRow[] {
  const rows: GoalRow[] = [];
  const today = startOfDay(opts.now);
  const groups: Array<{ key: string; label: string; role: ColorRole; items: GoalListItem[] }> = [
    { key: 'needs', label: 'NEEDS YOU', role: 'caution', items: [] },
    { key: 'running', label: 'RUNNING', role: 'live', items: [] },
    { key: 'today', label: 'TODAY', role: 'tertiary', items: [] },
    { key: 'yesterday', label: 'YESTERDAY', role: 'tertiary', items: [] },
    { key: 'week', label: 'EARLIER THIS WEEK', role: 'tertiary', items: [] },
    { key: 'older', label: 'OLDER', role: 'tertiary', items: [] },
  ];
  const group = (key: string) => groups.find(g => g.key === key)!.items;
  for (const item of items) {
    if (needsPerson(item)) group('needs').push(item);
    else if (item.status === 'active' || item.status === 'paused') group('running').push(item);
    else if (item.updatedAt >= today) group('today').push(item);
    else if (item.updatedAt >= today - 86400000) group('yesterday').push(item);
    else if (item.updatedAt >= today - 6 * 86400000) group('week').push(item);
    else group('older').push(item);
  }
  for (const g of groups) {
    if (g.items.length === 0) continue;
    g.items.sort((a, b) => b.updatedAt - a.updatedAt);
    rows.push({ id: `group:${g.key}`, kind: 'section', depth: 0, text: g.label, display: true, iconColorRole: g.role, textColorRole: g.role });
    for (const item of g.items) {
      const selected = item.id === opts.selectedId;
      const needs = needsPerson(item);
      const icon: { name: IconName; role: ColorRole } = needs ? { name: 'dot', role: 'caution' }
        : item.status === 'active' ? { name: 'dot', role: 'live' }
        : item.status === 'paused' ? { name: 'dot', role: 'neutral' }
        : item.status === 'completed' ? { name: 'check', role: 'success' }
        : item.status === 'failed' ? { name: 'close', role: 'error' }
        : { name: 'check', role: 'tertiary' };
      const line = needs ? `Asks: ${oneLine(item.question!, 200)}` : item.line;
      rows.push({
        id: `item:${item.id}`, kind: 'item', depth: 0, click: 'select',
        text: item.isRemote ? `${remoteBadge(item.creatorPeerId)} ${item.title}` : item.title,
        bold: selected,
        iconName: icon.name, iconColorRole: icon.role, textColorRole: 'primary',
        meta: item.status === 'active' || item.status === 'paused'
          ? formatDuration(opts.now - item.createdAt)
          : formatWhen(item.updatedAt, opts.now),
        metaColorRole: 'tertiary',
        ...(line ? {
          detail: line,
          detailColorRole: item.status === 'failed' ? 'error' as ColorRole : needs ? 'caution' as ColorRole : 'secondary' as ColorRole,
        } : {}),
        ...(selected ? { band: 'selected' as BandRole } : needs ? { band: 'caution' as BandRole } : {}),
      });
    }
  }
  return rows;
}

/** What a running goal is doing right now, in one line: agent, step, time. */
export function nowLine(view: Pick<GoalView, 'progress' | 'tasks' | 'status'>, now: number): string | undefined {
  const { trails, planner, reported } = attributeProgress(view);
  let best: { at: number; text: string } | undefined;
  for (const task of view.tasks) {
    if (!isRunning(task, reported)) continue;
    const trail = trails.get(task.id);
    const step = trail?.steps[trail.steps.length - 1];
    if (!trail || !step) continue;
    const text = `${trail.agentName ?? task.agentName ?? 'Agent'} · ${currentStepLabel(step)} · ${formatDuration(now - step.phaseAt)}`;
    if (!best || trail.lastAt > best.at) best = { at: trail.lastAt, text };
  }
  if (best) return best.text;
  if (view.status === 'paused') return 'Paused';
  return planner ? `${planner.agentName} · ${oneLine(planner.message, 120)}` : undefined;
}

/** Short peer tag for the [Remote: <peer>] badge. */
export function remoteBadge(peerId: string | undefined): string {
  if (!peerId) return '';
  return `[Remote: ${peerId.slice(0, 8)}]`;
}

/** Task states that will not change any more. */
export { isTerminal };
