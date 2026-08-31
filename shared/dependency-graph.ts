import type { Dependency, Task, Workflow } from "./contracts.ts";
import { compareText } from "./compare.ts";

export type DependencyUncertainty =
  | "ambiguous"
  | "cycle"
  | "closed"
  | "duplicate"
  | "gate"
  | "residue"
  | "self"
  | "unresolved";

/** A relationship that can be shown even when it is not safe to count as impact. */
export interface DependencyDisplayEdge {
  readonly prerequisite: Task;
  readonly dependant: Task;
  readonly gate: string | null;
  readonly actionable: boolean;
  readonly uncertainty: readonly DependencyUncertainty[];
}

export interface DependencyGraph {
  readonly cycleIds: ReadonlySet<string>;
  readonly tasksById: ReadonlyMap<string, Task>;
  readonly displayEdges: readonly DependencyDisplayEdge[];
  directPrerequisites(taskId: string): readonly Task[];
  directPrerequisiteEntries(taskId: string): readonly DependencyDisplayEdge[];
  directDependantEntries(taskId: string): readonly DependencyDisplayEdge[];
  directOpenDependants(taskId: string): readonly Task[];
  directUncertainDependants(taskId: string): readonly Task[];
  upstreamOf(taskId: string): ReadonlySet<string>;
  actionableFanOut(taskId: string): number;
}

function compareTasks(a: Task, b: Task, workflow: Workflow): number {
  const rank = (task: Task): number => {
    const index = task.priority === null ? -1 : workflow.priorityOrder.indexOf(task.priority);
    return index === -1 ? workflow.priorityOrder.length : index;
  };
  return rank(a) - rank(b) || compareText(a.id, b.id);
}

export function isImpactClosed(task: Task, workflow: Workflow): boolean {
  return task.statusBase !== null && workflow.closedStatuses.includes(task.statusBase);
}

function cycleMembers(edges: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();

  const visit = (id: string): void => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    stack.pop();
    active.delete(id);
  };

  for (const id of edges.keys()) visit(id);
  return cyclic;
}

interface Candidate {
  readonly prerequisite: Task;
  readonly dependant: Task;
  readonly dependencies: readonly Dependency[];
}

function candidateKey(prerequisiteId: string, dependantId: string): string {
  return `${prerequisiteId}\u0000${dependantId}`;
}

function taskDependencyUncertainty(
  task: Task,
  tasksById: ReadonlyMap<string, Task>,
  workflow: Workflow,
  cycleIds: ReadonlySet<string> = new Set(),
): ReadonlySet<DependencyUncertainty> {
  const reasons = new Set<DependencyUncertainty>();
  if (task.dependencyResidue.length > 0) reasons.add("residue");
  if (cycleIds.has(task.id)) reasons.add("cycle");
  for (const dependency of task.dependencies) {
    if (dependency.id === task.id) reasons.add("self");
    if (dependency.duplicate) reasons.add("duplicate");
    if (dependency.ambiguous) reasons.add("ambiguous");
    if (!dependency.resolved) reasons.add("unresolved");
    if (dependency.gate !== null) reasons.add("gate");
    if (cycleIds.has(dependency.id)) reasons.add("cycle");
    const dependencyStatus = tasksById.get(dependency.id)?.statusBase ?? null;
    if (
      dependencyStatus !== null &&
      workflow.closedStatuses.includes(dependencyStatus) &&
      !workflow.dependencySatisfiedStatuses.includes(dependencyStatus)
    ) reasons.add("closed");
  }
  return reasons;
}

function initialUncertainty(
  candidate: Candidate,
  tasksById: ReadonlyMap<string, Task>,
  workflow: Workflow,
): readonly DependencyUncertainty[] {
  const reasons = new Set(taskDependencyUncertainty(candidate.dependant, tasksById, workflow));
  if (candidate.dependencies.length > 1) reasons.add("duplicate");
  return [...reasons];
}

function compareEntries(
  a: DependencyDisplayEdge,
  b: DependencyDisplayEdge,
  direction: "upstream" | "downstream",
  workflow: Workflow,
): number {
  if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
  const left = direction === "upstream" ? a.prerequisite : a.dependant;
  const right = direction === "upstream" ? b.prerequisite : b.dependant;
  return compareTasks(left, right, workflow);
}

/**
 * One dependency graph with two deliberately separate domains:
 *
 * - display edges keep resolvable relationships visible with their uncertainty;
 * - actionable edges are the strict subset that may inform Now and impact totals.
 *
 * Keeping them together prevents the graph from silently deleting a gated or
 * cyclic relationship while ensuring malformed planning text never inflates a
 * recommendation.
 */
export function buildDependencyGraph(tasks: readonly Task[], workflow: Workflow): DependencyGraph {
  const matches = new Map<string, Task[]>();
  for (const task of tasks) {
    const bucket = matches.get(task.id);
    if (bucket) bucket.push(task);
    else matches.set(task.id, [task]);
  }

  const tasksById = new Map<string, Task>();
  for (const [id, candidates] of matches) {
    if (candidates.length === 1) tasksById.set(id, candidates[0]!);
  }

  const candidates = new Map<string, Candidate>();
  for (const dependant of tasksById.values()) {
    for (const dependency of dependant.dependencies) {
      const prerequisite = tasksById.get(dependency.id);
      if (!prerequisite || prerequisite.id === dependant.id) continue;
      const key = candidateKey(prerequisite.id, dependant.id);
      const current = candidates.get(key);
      if (current) {
        candidates.set(key, { ...current, dependencies: [...current.dependencies, dependency] });
      } else {
        candidates.set(key, { prerequisite, dependant, dependencies: [dependency] });
      }
    }
  }

  const initiallyActionable = new Map<string, boolean>();
  const structuralUpstream = new Map<string, string[]>();
  for (const taskId of tasksById.keys()) structuralUpstream.set(taskId, []);
  for (const [key, candidate] of candidates) {
    const actionable = initialUncertainty(candidate, tasksById, workflow).length === 0;
    initiallyActionable.set(key, actionable);
    structuralUpstream.get(candidate.dependant.id)!.push(candidate.prerequisite.id);
  }

  const cycleIds = cycleMembers(structuralUpstream);
  const upstream = new Map<string, string[]>();
  const dependants = new Map<string, string[]>();
  const displayEdges: DependencyDisplayEdge[] = [];
  for (const [key, candidate] of candidates) {
    const uncertainty = new Set(initialUncertainty(candidate, tasksById, workflow));
    for (const reason of taskDependencyUncertainty(candidate.dependant, tasksById, workflow, cycleIds)) {
      uncertainty.add(reason);
    }
    if (cycleIds.has(candidate.prerequisite.id) || cycleIds.has(candidate.dependant.id)) {
      uncertainty.add("cycle");
    }
    const actionable = initiallyActionable.get(key) === true && uncertainty.size === 0;
    displayEdges.push({
      prerequisite: candidate.prerequisite,
      dependant: candidate.dependant,
      gate: candidate.dependencies.find((dependency) => dependency.gate !== null)?.gate ?? null,
      actionable,
      uncertainty: [...uncertainty],
    });
    if (!actionable) continue;
    const prerequisiteIds = upstream.get(candidate.dependant.id) ?? [];
    prerequisiteIds.push(candidate.prerequisite.id);
    upstream.set(candidate.dependant.id, prerequisiteIds);
    const dependantIds = dependants.get(candidate.prerequisite.id) ?? [];
    dependantIds.push(candidate.dependant.id);
    dependants.set(candidate.prerequisite.id, dependantIds);
  }
  for (const taskId of tasksById.keys()) upstream.set(taskId, upstream.get(taskId) ?? []);

  const displayByPrerequisite = new Map<string, DependencyDisplayEdge[]>();
  const displayByDependant = new Map<string, DependencyDisplayEdge[]>();
  for (const edge of displayEdges) {
    const down = displayByPrerequisite.get(edge.prerequisite.id) ?? [];
    down.push(edge);
    displayByPrerequisite.set(edge.prerequisite.id, down);
    const up = displayByDependant.get(edge.dependant.id) ?? [];
    up.push(edge);
    displayByDependant.set(edge.dependant.id, up);
  }

  const tasksFor = (ids: readonly string[]): Task[] =>
    ids
      .map((id) => tasksById.get(id))
      .filter((task): task is Task => task !== undefined)
      .sort((a, b) => compareTasks(a, b, workflow));
  const displayFor = (taskId: string, direction: "upstream" | "downstream"): readonly DependencyDisplayEdge[] =>
    [...((direction === "upstream" ? displayByDependant.get(taskId) : displayByPrerequisite.get(taskId)) ?? [])]
      .sort((a, b) => compareEntries(a, b, direction, workflow));

  return {
    cycleIds,
    tasksById,
    displayEdges: [...displayEdges].sort((a, b) =>
      compareText(a.prerequisite.id, b.prerequisite.id) ||
      compareText(a.dependant.id, b.dependant.id),
    ),
    directPrerequisites(taskId) {
      return tasksFor(upstream.get(taskId) ?? []);
    },
    directPrerequisiteEntries(taskId) {
      return displayFor(taskId, "upstream");
    },
    directDependantEntries(taskId) {
      const root = tasksById.get(taskId);
      if (!root || isImpactClosed(root, workflow)) return [];
      return displayFor(taskId, "downstream").filter((edge) => !isImpactClosed(edge.dependant, workflow));
    },
    directOpenDependants(taskId) {
      const root = tasksById.get(taskId);
      if (!root || isImpactClosed(root, workflow)) return [];
      return tasksFor(dependants.get(taskId) ?? []).filter((task) => !isImpactClosed(task, workflow));
    },
    directUncertainDependants(taskId) {
      const root = tasksById.get(taskId);
      if (!root || isImpactClosed(root, workflow)) return [];
      return displayFor(taskId, "downstream")
        .filter((edge) => !edge.actionable && !isImpactClosed(edge.dependant, workflow))
        .map((edge) => edge.dependant);
    },
    upstreamOf(taskId) {
      const seen = new Set<string>();
      const stack = [...(upstream.get(taskId) ?? [])];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current)) continue;
        const task = tasksById.get(current);
        if (!task) continue;
        seen.add(current);
        if (isImpactClosed(task, workflow)) continue;
        stack.push(...(upstream.get(current) ?? []));
      }
      return seen;
    },
    actionableFanOut(taskId) {
      const root = tasksById.get(taskId);
      if (!root || isImpactClosed(root, workflow)) return 0;
      const seen = new Set<string>();
      const stack = [...(dependants.get(taskId) ?? [])];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current)) continue;
        const task = tasksById.get(current);
        if (!task || isImpactClosed(task, workflow)) continue;
        seen.add(current);
        stack.push(...(dependants.get(current) ?? []));
      }
      return seen.size;
    },
  };
}
