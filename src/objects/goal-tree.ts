/**
 * goal-tree — shared, UI-agnostic row model for rendering goal progress.
 *
 * Both the GoalBrowser window and the inline activity view in Chat display the
 * same goal / description / task / progress hierarchy. This module owns the one
 * graph walk that turns goals + their tasks into a flat, depth-annotated list of
 * rows, so the two surfaces never drift. It emits full (untruncated) text and
 * abstract colour roles — the widget resolves roles to concrete theme colours
 * and wraps the text — keeping this module free of any rendering concerns.
 */

import type { IconName } from '../ui/icons.js';

export type GoalRowKind = 'goal' | 'description' | 'task' | 'progress' | 'error';

/**
 * Abstract colour role. The widget maps these to theme colours so the same row
 * model renders correctly under any theme. Icon and text carry separate roles:
 * a goal row's icon reflects status (warning/success/error) while its text uses
 * the primary reading colour.
 */
export type ColorRole =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'warning'
  | 'success'
  | 'error'
  | 'neutral';

export interface GoalRow {
  /** Prefixed id: "goal:<id>" | "description:<id>" | "task:<id>" | "progress:<id>" | "error:<id>". */
  id: string;
  kind: GoalRowKind;
  depth: number;
  /** Full text — never truncated; the widget word-wraps it. */
  text: string;
  iconName: IconName;
  iconColorRole: ColorRole;
  textColorRole: ColorRole;
  /** goal rows only — drives the expand/collapse arrow. */
  expanded?: boolean;
  /** goal rows only. */
  hasChildren?: boolean;
}

/** Normalised goal shape both callers map into (a full Goal or a Chat live-goal). */
export interface GoalNode {
  id: string;
  parentId?: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'failed' | 'archived';
  /** Latest progress message, if any. */
  latestMessage?: string;
  /** Agent that emitted the latest progress message, if known. */
  latestAgent?: string;
  /** Failure reason for failed goals. */
  error?: string;
}

/** Normalised task shape (a superset-compatible view of both callers' task rows). */
export interface TaskNode {
  id: string;
  description: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  claimedBy?: string;
  agentName?: string;
}

const GOAL_STATUS_ICON_NAMES: Record<string, IconName> = {
  active:    'chevronRight',
  completed: 'check',
  failed:    'close',
};

const TASK_STATUS_ICON_NAMES: Record<string, IconName> = {
  pending:            'dot',
  claimed:            'chevronRight',
  in_progress:        'chevronRight',
  done:               'check',
  permanently_failed: 'close',
};

function goalStatusRole(status: GoalNode['status']): ColorRole {
  switch (status) {
    case 'active':    return 'warning';
    case 'completed': return 'success';
    case 'failed':    return 'error';
    default:          return 'neutral';
  }
}

/**
 * Walk the goal graph and produce a flat list of display rows.
 *
 * Callers stay decoupled from branded id types by passing closures:
 *   - isExpanded(goalId) — whether a goal's children are shown
 *   - getTasks(goalId)   — the tasks under a goal
 * Pass `rootId` to render a single subtree (Chat, scoped to the running goal);
 * omit it to render every top-level goal (GoalBrowser).
 */
export function buildGoalRows(input: {
  goals: GoalNode[];
  isExpanded: (goalId: string) => boolean;
  getTasks: (goalId: string) => TaskNode[];
  rootId?: string;
}): GoalRow[] {
  const { goals, isExpanded, getTasks, rootId } = input;
  const rows: GoalRow[] = [];

  // parent -> children map for nesting
  const childrenOf = new Map<string, GoalNode[]>();
  const topLevel: GoalNode[] = [];
  for (const goal of goals) {
    if (goal.parentId) {
      const siblings = childrenOf.get(goal.parentId) ?? [];
      siblings.push(goal);
      childrenOf.set(goal.parentId, siblings);
    } else {
      topLevel.push(goal);
    }
  }

  const byId = new Map<string, GoalNode>();
  for (const goal of goals) byId.set(goal.id, goal);

  const visited = new Set<string>();

  const renderGoal = (goal: GoalNode, depth: number): void => {
    if (visited.has(goal.id)) return;
    visited.add(goal.id);

    const expanded = isExpanded(goal.id);
    const tasks = getTasks(goal.id);
    const children = childrenOf.get(goal.id) ?? [];
    const latestMessage = goal.latestMessage ?? '';
    const hasChildren = tasks.length > 0 || children.length > 0
      || (goal.status === 'active' && !!latestMessage)
      || (goal.status === 'failed' && !!goal.error)
      || (!!goal.description && goal.description.trim() !== goal.title.trim());

    rows.push({
      id: `goal:${goal.id}`,
      kind: 'goal',
      depth,
      text: goal.title,
      iconName: GOAL_STATUS_ICON_NAMES[goal.status] ?? 'dot',
      iconColorRole: goalStatusRole(goal.status),
      textColorRole: 'primary',
      expanded,
      hasChildren,
    });

    if (!expanded) return;

    // The user's intent (goal description) — first, so the reader sees what was
    // asked for before the planned work.
    if (goal.description && goal.description.trim() && goal.description.trim() !== goal.title.trim()) {
      rows.push({
        id: `description:${goal.id}`,
        kind: 'description',
        depth: depth + 1,
        text: goal.description,
        iconName: 'info',
        iconColorRole: 'secondary',
        textColorRole: 'secondary',
      });
    }

    // Tasks
    for (const task of tasks) {
      const effectiveStatus = task.status === 'pending' && task.claimedBy ? 'claimed' : task.status;
      const attempts = task.attempts > 0 ? ` (${task.attempts}/${task.maxAttempts})` : '';
      const agent = task.agentName ? `[${task.agentName}] ` : '';
      rows.push({
        id: `task:${task.id}`,
        kind: 'task',
        depth: depth + 1,
        text: `${agent}${task.description}${attempts}`,
        iconName: TASK_STATUS_ICON_NAMES[effectiveStatus] ?? 'dot',
        iconColorRole: effectiveStatus === 'done' ? 'success'
          : effectiveStatus === 'permanently_failed' ? 'error'
          : 'secondary',
        textColorRole: 'secondary',
      });
    }

    // Sub-goals nested under this goal
    for (const child of children) {
      renderGoal(child, depth + 1);
    }

    // Failure detail — full error text (not truncated into the title).
    if (goal.status === 'failed' && goal.error) {
      rows.push({
        id: `error:${goal.id}`,
        kind: 'error',
        depth: depth + 1,
        text: goal.error,
        iconName: 'close',
        iconColorRole: 'error',
        textColorRole: 'error',
      });
    }

    // Latest progress line for active goals — includes the reporting agent so
    // the reader sees who is doing what.
    if (goal.status === 'active' && latestMessage) {
      const agent = goal.latestAgent ? `[${goal.latestAgent}] ` : '';
      rows.push({
        id: `progress:${goal.id}`,
        kind: 'progress',
        depth: depth + 1,
        text: `${agent}${latestMessage}`,
        iconName: 'dot',
        iconColorRole: 'tertiary',
        textColorRole: 'tertiary',
      });
    }
  };

  if (rootId) {
    const root = byId.get(rootId);
    if (root) renderGoal(root, 0);
  } else {
    for (const goal of topLevel) renderGoal(goal, 0);
  }

  return rows;
}
