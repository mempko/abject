/**
 * task-graph — the shared reading of a round's dependency graph.
 *
 * A scrum round is a DAG: tasks declare what they depend on, and several can
 * run at once. Four surfaces need to say something about that graph — the
 * GoalBrowser window, Chat's activity bubble, the `commune` terminal client,
 * and the scheduler deciding what to start next — and three of them are
 * rendering it for a person.
 *
 * They must not each work it out for themselves. That is the same argument
 * that produced `goal-tree.ts` for the two widget surfaces, applied one layer
 * down and one surface wider, because the CLI does not share that module.
 *
 * Everything here is UI-agnostic and works on a minimal node shape, so the
 * terminal client can bundle it without dragging in anything visual.
 */

import { require as contractRequire } from './contracts.js';

/** The least a task has to expose to be placed in the graph. */
export interface GraphNode {
  id: string;
  /** Task ids this one waits on. Absent or empty means it can start. */
  dependsOn?: string[];
  /** Lifecycle state. Only terminality is interpreted here. */
  status?: string;
}

/** Statuses that mean a dependency will never be satisfied by waiting. */
const TERMINAL_OK = new Set(['done', 'completed']);
const TERMINAL_BAD = new Set(['permanently_failed', 'failed', 'cancelled']);

export function isSatisfied(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_OK.has(status);
}

export function isTerminal(status: string | undefined): boolean {
  return status !== undefined && (TERMINAL_OK.has(status) || TERMINAL_BAD.has(status));
}

/**
 * Dependencies of `node` that have not been satisfied yet, as ids.
 *
 * This is the annotation that matters when watching a wide round: not where a
 * task sits in a picture, but why it has not started.
 */
export function blockedOn<T extends GraphNode>(node: T, byId: Map<string, T>): string[] {
  const deps = node.dependsOn ?? [];
  if (deps.length === 0) return [];
  return deps.filter(id => {
    const dep = byId.get(id);
    // A dependency we cannot see is treated as outstanding: claiming a task is
    // ready because its blocker is missing from this view would be a worse lie
    // than showing it as waiting.
    return !dep || !isSatisfied(dep.status);
  });
}

/** Index a node list by id. */
export function indexById<T extends GraphNode>(nodes: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const n of nodes) byId.set(n.id, n);
  return byId;
}

/**
 * Order nodes so every dependency precedes its dependents.
 *
 * Kahn's algorithm, taking ready nodes in their original order so the result
 * is stable and a round that has no edges at all comes back exactly as it was
 * staged. Nodes in a cycle, or depending on something outside the set, cannot
 * be placed and are appended in their original order rather than dropped: this
 * is a reading of the graph for display and scheduling, and losing a task
 * would be worse than showing it late.
 */
export function orderTopologically<T extends GraphNode>(nodes: readonly T[]): T[] {
  const byId = indexById(nodes);
  const remaining = new Map<string, number>();
  for (const n of nodes) {
    // Only count edges to nodes actually in this set; an edge pointing outside
    // it (a key produced in an earlier round) is not something to wait for.
    remaining.set(n.id, (n.dependsOn ?? []).filter(d => byId.has(d) && d !== n.id).length);
  }

  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of n.dependsOn ?? []) {
      if (!byId.has(d) || d === n.id) continue;
      const list = dependents.get(d);
      if (list) list.push(n.id);
      else dependents.set(d, [n.id]);
    }
  }

  const out: T[] = [];
  const placed = new Set<string>();
  let ready = nodes.filter(n => (remaining.get(n.id) ?? 0) === 0).map(n => n.id);

  while (ready.length > 0) {
    const next: string[] = [];
    for (const id of ready) {
      if (placed.has(id)) continue;
      placed.add(id);
      const node = byId.get(id);
      if (node) out.push(node);
      for (const dep of dependents.get(id) ?? []) {
        const left = (remaining.get(dep) ?? 0) - 1;
        remaining.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    ready = next;
  }

  for (const n of nodes) if (!placed.has(n.id)) out.push(n);
  return out;
}

/**
 * How much work sits behind each node: the number of tasks that cannot run
 * until it finishes, counted transitively.
 *
 * This is the weight a scheduler wants when it has more ready tasks than free
 * slots. Starting the task with the longest tail behind it is the standard
 * critical-path heuristic, and staging order — which is what a plain queue
 * uses — is an arbitrary basis for the same decision.
 */
export function transitiveDependentCounts<T extends GraphNode>(nodes: readonly T[]): Map<string, number> {
  const byId = indexById(nodes);
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of n.dependsOn ?? []) {
      if (!byId.has(d) || d === n.id) continue;
      const list = dependents.get(d);
      if (list) list.push(n.id);
      else dependents.set(d, [n.id]);
    }
  }

  const counts = new Map<string, number>();
  for (const n of nodes) {
    // Breadth-first over dependents, with a seen set so a diamond counts each
    // downstream task once and a cycle cannot spin.
    const seen = new Set<string>();
    const queue = [...(dependents.get(n.id) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === n.id || seen.has(id)) continue;
      seen.add(id);
      for (const d of dependents.get(id) ?? []) queue.push(d);
    }
    counts.set(n.id, seen.size);
  }
  return counts;
}

/**
 * Edges implied by the data contracts: if one task consumes a key another
 * produces, the consumer depends on the producer whether or not anyone said so.
 *
 * Returns the derived edges only, so a caller can tell what it inferred from
 * what was declared. Self-edges are skipped rather than deadlocking a task
 * against itself, and a key with several producers is left alone here because
 * choosing between them is a judgment the caller should refuse rather than
 * guess (see `validateDataFlow`).
 */
export function deriveContractEdges(
  tasks: ReadonlyArray<{ produces?: Array<{ key?: string }>; consumes?: string[] }>,
): Array<{ from: number; to: number; key: string }> {
  const producerOf = new Map<string, number[]>();
  tasks.forEach((t, i) => {
    for (const p of t.produces ?? []) {
      if (!p?.key) continue;
      const list = producerOf.get(p.key);
      if (list) list.push(i);
      else producerOf.set(p.key, [i]);
    }
  });

  const edges: Array<{ from: number; to: number; key: string }> = [];
  tasks.forEach((t, i) => {
    for (const key of t.consumes ?? []) {
      const producers = producerOf.get(key);
      if (!producers || producers.length !== 1) continue; // absent or ambiguous
      const from = producers[0];
      if (from === i) continue;
      edges.push({ from, to: i, key });
    }
  });
  return edges;
}

export interface DataFlowProblem {
  kind: 'unproduced' | 'ambiguous' | 'self-dependency';
  taskIndex: number;
  message: string;
}

/**
 * Check a staged round's data contracts before it runs.
 *
 * Once edges come from the contracts, the contracts are load-bearing. A
 * consumed key nobody produces is a planning bug whose symptom arrives much
 * later, as an agent reading a key that is not there and either failing
 * confusingly or inventing a value.
 *
 * `existingKeys` is the goal scratchpad as it already stands: consuming a key
 * produced in an earlier round is legitimate and common, so checking only the
 * current batch would reject good plans.
 */
export function validateDataFlow(
  tasks: ReadonlyArray<{
    description?: string;
    produces?: Array<{ key?: string }>;
    consumes?: string[];
    dependsOnIdx?: number[];
  }>,
  existingKeys: ReadonlySet<string>,
): DataFlowProblem[] {
  contractRequire(Array.isArray(tasks), 'tasks must be an array');
  const problems: DataFlowProblem[] = [];

  const producerOf = new Map<string, number[]>();
  tasks.forEach((t, i) => {
    for (const p of t.produces ?? []) {
      if (!p?.key) continue;
      const list = producerOf.get(p.key);
      if (list) list.push(i);
      else producerOf.set(p.key, [i]);
    }
  });

  for (const [key, producers] of producerOf) {
    if (producers.length > 1) {
      problems.push({
        kind: 'ambiguous',
        taskIndex: producers[1],
        message:
          `key "${key}" is produced by ${producers.length} tasks in this round ` +
          `(${producers.join(', ')}). A consumer cannot tell which one it waits for — ` +
          `have one task produce it, or give them distinct keys.`,
      });
    }
  }

  tasks.forEach((t, i) => {
    if ((t.dependsOnIdx ?? []).includes(i)) {
      problems.push({
        kind: 'self-dependency',
        taskIndex: i,
        message: `task ${i} depends on itself and would never start.`,
      });
    }
    for (const key of t.consumes ?? []) {
      if (producerOf.has(key) || existingKeys.has(key)) continue;
      const available = [...producerOf.keys(), ...existingKeys].sort();
      problems.push({
        kind: 'unproduced',
        taskIndex: i,
        message:
          `task ${i} consumes "${key}", which no task in this round produces and ` +
          `which is not already on the goal scratchpad. Available: ` +
          `${available.length > 0 ? available.join(', ') : '(none)'}.`,
      });
    }
  });

  return problems;
}
