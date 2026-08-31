import type { Board, Task } from "./contracts.ts";

export function readinessReasons(board: Board, task: Task): string[] {
  if (task.readiness === null) return [];
  if (task.readiness === "startable") {
    return ["Every dependency has a configured satisfied status and no unchecked gate remains."];
  }

  const reasons: string[] = [];
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const cyclic = new Set(
    board.issues
      .filter((issue) => issue.kind === "dependency-cycle")
      .map((issue) => issue.taskId),
  );

  if (task.statusBase && board.workflow.blockedStatuses.includes(task.statusBase)) {
    add(`The task status is ${task.statusBase}.`);
  }
  if (!task.statusValid) add("The current status is not in this document's vocabulary.");
  if (
    task.statusBase &&
    !board.workflow.activeStatuses.includes(task.statusBase) &&
    !board.workflow.blockedStatuses.includes(task.statusBase)
  ) {
    add(`${task.statusBase} is not an active readiness state.`);
  }
  if (board.issues.some(
    (issue) =>
      issue.kind === "duplicate-task-id" &&
      issue.taskId === task.id &&
      issue.file === task.file &&
      issue.line === task.line,
  )) {
    add(`${task.id} is defined by more than one ledger row.`);
  }
  if (cyclic.has(task.id)) add("The task participates in a dependency cycle.");
  if (task.dependencyResidue.length > 0) add("Dependency text contains unparsed content that needs review.");
  for (const dependency of task.dependencies) {
    const matches = board.tasks.filter((candidate) => candidate.id === dependency.id);
    if (dependency.id === task.id) add("The task lists itself as a dependency.");
    if (dependency.ambiguous) add(`${dependency.id} is defined by more than one row.`);
    else if (!dependency.resolved) add(`${dependency.id} is not defined in the planning corpus.`);
    if (dependency.duplicate) add(`${dependency.id} is listed more than once.`);
    if (dependency.gate) add(`${dependency.id} also requires the unchecked @${dependency.gate} gate.`);
    if (cyclic.has(dependency.id)) add(`${dependency.id} participates in a dependency cycle.`);
    if (matches.length === 1 && !matches[0]!.statusValid) {
      add(`${dependency.id} has a status outside its document vocabulary: ${matches[0]!.status}.`);
    }
  }

  if (task.readiness === "waiting") {
    for (const dependency of task.dependencies) {
      const matches = board.tasks.filter((candidate) => candidate.id === dependency.id);
      const status = matches[0]?.statusBase ?? null;
      if (
        matches.length !== 1 ||
        (status !== null && board.workflow.dependencySatisfiedStatuses.includes(status))
      ) continue;
      add(`${dependency.id} is ${matches[0]!.status || "not satisfied"}.`);
    }
  }
  return reasons.length > 0 ? reasons : ["A dependency needs a manual gate check."];
}
