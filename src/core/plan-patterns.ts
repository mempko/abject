/**
 * The patterns a goal's plan follows, read from its recorded plan revisions.
 *
 * ScrumMaster declares them as it plans (`patterns` on the whole plan, and on
 * each staged task it governs); the post-goal reviewer reads the same record
 * back to judge each pattern against what the goal did. Both read it here,
 * so declaration and judgment agree on what was declared.
 */

/** One declared pattern: its id and the planner's reason. */
export interface PatternDeclaration { id: string; why: string }

/** A recorded plan revision as GoalManager keeps it under `learning/plans`. */
export interface RecordedPlan { revision: number; plan?: unknown }

/** Pattern declarations from model output: `[{ id, why }]`, bare ids accepted. */
export function declaredPatterns(raw: unknown): PatternDeclaration[] {
  if (!Array.isArray(raw)) return [];
  const out: PatternDeclaration[] = [];
  for (const p of raw.slice(0, 8)) {
    const id = typeof p === 'string' ? p
      : p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string' ? (p as { id: string }).id : undefined;
    if (!id || out.some(o => o.id === id)) continue;
    const why = p && typeof p === 'object' && typeof (p as { why?: unknown }).why === 'string' ? (p as { why: string }).why.slice(0, 500) : '';
    out.push({ id, why });
  }
  return out;
}

/** The staged tasks of a plan revision, as recorded. */
function plannedTasks(plan: unknown): Array<{ name?: string; description?: string; patterns: PatternDeclaration[] }> {
  const tasks = plan && typeof plan === 'object' ? (plan as { tasks?: unknown }).tasks : undefined;
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(t => t && typeof t === 'object').map(t => {
    const task = t as { name?: unknown; description?: unknown; patterns?: unknown };
    return {
      ...(typeof task.name === 'string' ? { name: task.name } : {}),
      ...(typeof task.description === 'string' ? { description: task.description } : {}),
      patterns: declaredPatterns(task.patterns),
    };
  });
}

/** Every pattern one plan revision follows, plan-wide and per task. */
export function planPatternIds(plan: unknown): string[] {
  const wide = declaredPatterns(plan && typeof plan === 'object' ? (plan as { patterns?: unknown }).patterns : undefined);
  return [...new Set([...wide, ...plannedTasks(plan).flatMap(t => t.patterns)].map(d => d.id))];
}

/** One pattern's course through a goal's plan revisions. */
export interface PlanPatternUse {
  id: string;
  /** Each revision that declared it, with the reason and what it governed. */
  declared: Array<{ revision: number; why: string; wholePlan: boolean; tasks: Array<{ name?: string; description?: string }> }>;
  /** Revisions that moved on without it, with the plan's account of the change. */
  dropped: Array<{ revision: number; change?: string; reason?: string }>;
}

/**
 * Follow each declared pattern through the plan's revisions: where it was
 * adopted, kept, dropped (and why the plan said it changed), and which tasks
 * it governed. A pattern a re-plan dropped is evidence about that pattern.
 */
export function planPatternTrail(plans: RecordedPlan[]): Map<string, PlanPatternUse> {
  const trail = new Map<string, PlanPatternUse>();
  let previous = new Set<string>();
  for (const { revision, plan } of [...plans].sort((a, b) => a.revision - b.revision)) {
    const body = plan && typeof plan === 'object' ? plan as { patterns?: unknown; change?: unknown; reason?: unknown } : {};
    const current = new Set<string>();
    for (const d of declaredPatterns(body.patterns)) {
      const use = trail.get(d.id) ?? { id: d.id, declared: [], dropped: [] };
      use.declared.push({ revision, why: d.why, wholePlan: true, tasks: [] });
      trail.set(d.id, use);
      current.add(d.id);
    }
    for (const task of plannedTasks(plan)) {
      for (const d of task.patterns) {
        const use = trail.get(d.id) ?? { id: d.id, declared: [], dropped: [] };
        let entry = use.declared.find(e => e.revision === revision && !e.wholePlan);
        if (!entry) { entry = { revision, why: d.why, wholePlan: false, tasks: [] }; use.declared.push(entry); }
        entry.tasks.push({ ...(task.name ? { name: task.name } : {}), ...(task.description ? { description: task.description } : {}) });
        trail.set(d.id, use);
        current.add(d.id);
      }
    }
    for (const id of previous) {
      if (current.has(id)) continue;
      trail.get(id)?.dropped.push({
        revision,
        ...(typeof body.change === 'string' ? { change: body.change.slice(0, 400) } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason.slice(0, 400) } : {}),
      });
    }
    previous = current;
  }
  return trail;
}
