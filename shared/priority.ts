import type { Task } from "./contracts.ts";
import { compareText } from "./compare.ts";

export function comparePriority(a: Task, b: Task, priorityOrder: readonly string[]): number {
  const rank = (task: Task): number => {
    const index = task.priority === null ? -1 : priorityOrder.indexOf(task.priority);
    return index === -1 ? priorityOrder.length : index;
  };
  return rank(a) - rank(b) || compareText(a.id, b.id);
}
