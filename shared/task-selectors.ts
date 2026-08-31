import type { Board, LastChange, Task } from "./contracts.ts";
import { buildDependencyGraph } from "./dependency-graph.ts";
import { comparePriority } from "./priority.ts";
import { daysSince } from "./time.ts";

export const STALE_DAYS = 7;

export interface StartableTaskSelection {
  readonly task: Task;
  readonly fanOut: number;
}

export interface StaleTaskSelection {
  readonly task: Task;
  readonly ageDays: number;
  readonly lastChange: LastChange;
}

export type LastChangeLookup =
  | Readonly<Record<string, LastChange>>
  | ((task: Task) => LastChange | undefined);

export function taskFanOut(
  board: Board,
  tasks: readonly Task[] = board.tasks,
): ReadonlyMap<string, number> {
  const graph = buildDependencyGraph(tasks, board.workflow);
  return new Map(tasks.map((task) => [task.id, graph.actionableFanOut(task.id)]));
}

export function selectStartableTasks(
  board: Board,
  tasks: readonly Task[] = board.tasks,
): readonly StartableTaskSelection[] {
  const counts = taskFanOut(board);
  return tasks
    .filter((task) => task.readiness === "startable")
    .map((task) => ({ task, fanOut: counts.get(task.id) ?? 0 }))
    .sort((left, right) =>
      right.fanOut - left.fanOut ||
      comparePriority(left.task, right.task, board.workflow.priorityOrder),
    );
}

export function selectStaleTasks(
  board: Board,
  lastChanged: LastChangeLookup,
  now: number | Date = Date.now(),
  tasks: readonly Task[] = board.tasks,
): readonly StaleTaskSelection[] {
  const instant = now instanceof Date ? now.getTime() : now;
  return tasks
    .filter((task) =>
      task.statusBase !== null && board.workflow.activeStatuses.includes(task.statusBase),
    )
    .flatMap((task): readonly StaleTaskSelection[] => {
      const lastChange = typeof lastChanged === "function"
        ? lastChanged(task)
        : lastChanged[task.id];
      if (!lastChange) return [];
      const ageDays = daysSince(lastChange.date, instant);
      return Number.isFinite(ageDays) && ageDays >= STALE_DAYS
        ? [{ task, ageDays, lastChange }]
        : [];
    })
    .sort((left, right) =>
      right.ageDays - left.ageDays ||
      comparePriority(left.task, right.task, board.workflow.priorityOrder),
    );
}
