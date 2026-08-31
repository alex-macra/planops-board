import type { Board, LastChange, ProjectSummary, Task } from "../shared/contracts.ts";
import { selectStaleTasks, STALE_DAYS, taskFanOut } from "../shared/task-selectors.ts";
import { isImpactClosed } from "./dependency-graph.ts";
import { comparePriority } from "./priority.ts";

export { STALE_DAYS };

export type NowGroupId = "land" | "stale" | "person" | "unblocks" | "start";

export interface NowRow {
  readonly task: Task;
  readonly note: string | null;
}

export interface NowGroup {
  readonly id: NowGroupId;
  readonly label: string;
  readonly rule: string;
  readonly rows: readonly NowRow[];
}

export interface FoldedReason {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export interface NowBoard {
  readonly groups: readonly NowGroup[];
  readonly shown: number;
  readonly total: number;
  readonly folded: readonly FoldedReason[];
  readonly parked: readonly ProjectSummary[];
  readonly historyReady: boolean;
}

export function isParked(task: Task, parked: ReadonlySet<string>): boolean {
  if (parked.size === 0) return false;
  const touched = new Set([task.project, ...task.projects]);
  return touched.size > 0 && [...touched].every((project) => parked.has(project));
}

export { taskFanOut as fanOut };

export function buildNow(
  board: Board,
  tasks: readonly Task[],
  lastChanged: Readonly<Record<string, LastChange>>,
  now = Date.now(),
): NowBoard {
  const parkedProjects = board.projects.filter((project) => project.parked !== null);
  const parkedIds = new Set(parkedProjects.map((project) => project.id));
  const historyReady = Object.keys(lastChanged).length > 0;

  const live = tasks.filter((task) => !isParked(task, parkedIds));
  const counts = taskFanOut(board);
  const stale = selectStaleTasks(board, lastChanged, now, live);
  const staleById = new Map(stale.map((entry, index) => [entry.task.id, { entry, index }]));

  const claimed = new Set<string>();
  const take = (
    id: NowGroupId,
    label: string,
    rule: string,
    pick: (task: Task) => string | null | false,
    sort?: (a: NowRow, b: NowRow) => number,
  ): NowGroup => {
    const rows: NowRow[] = [];
    for (const task of live) {
      if (claimed.has(task.id)) continue;
      const note = pick(task);
      if (note === false) continue;
      claimed.add(task.id);
      rows.push({ task, note });
    }
    rows.sort(sort ?? ((a, b) => comparePriority(a.task, b.task, board.workflow.priorityOrder)));
    return { id, label, rule, rows };
  };

  const groups: NowGroup[] = [
    take(
      "stale",
      "Going stale",
      `Active tasks whose latest Git change is at least ${STALE_DAYS} days old.`,
      (task) => {
        if (!historyReady) return false;
        const match = staleById.get(task.id)?.entry;
        return match ? `${match.ageDays}d untouched` : false;
      },
      (a, b) => (staleById.get(a.task.id)?.index ?? 0) - (staleById.get(b.task.id)?.index ?? 0),
    ),
    take(
      "person",
      "Needs a person",
      "Startable, but every named owner is a role or group rather than a repository, so ownership is unclear.",
      (task) =>
        task.readiness === "startable" && task.owners.length > 0 && task.repositories.length === 0
          ? task.owners.join(", ")
          : false,
    ),
    take(
      "unblocks",
      "Unblocks the most",
      "Startable or moving, ranked by how many open rows are waiting behind them.",
      (task) => {
        if (isImpactClosed(task, board.workflow)) return false;
        if (task.readiness === "needs-gate-check" || task.readiness === null) return false;
        if (
          task.readiness !== "startable" &&
          (task.statusBase === null || !board.workflow.activeStatuses.includes(task.statusBase))
        ) return false;
        const count = counts.get(task.id) ?? 0;
        return count > 0 ? `unblocks ${count}` : false;
      },
      (a, b) => (counts.get(b.task.id) ?? 0) - (counts.get(a.task.id) ?? 0),
    ),
    take(
      "start",
      "Pick one up",
      "Every dependency satisfied and nothing started yet. Highest priority first.",
      // Same: priority has its own column two cells to the left.
      (task) =>
        task.readiness === "startable" ? null : false,
    ),
    take(
      "land",
      "Active work",
      "Configured as active and not already shown by a more specific signal.",
      (task) => task.statusBase !== null && board.workflow.activeStatuses.includes(task.statusBase) ? null : false,
    ),
  ].filter((group) => group.rows.length > 0);

  // Exclusive for the same reason the groups are: a row that is both blocked
  // and in progress would otherwise be folded away twice and the strip would
  // claim to have hidden more rows than exist.
  const rest = tasks.filter((task) => !claimed.has(task.id));
  const reasons: { key: string; label: string; test: (task: Task) => boolean }[] = [
    { key: "parked", label: "in a parked product", test: (task) => isParked(task, parkedIds) },
    { key: "closed", label: "in a closed status", test: (task) => isImpactClosed(task, board.workflow) },
    {
      key: "needs-gate-check",
      label: "needing a gate check",
      test: (task) => task.readiness === "needs-gate-check",
    },
    { key: "waiting", label: "waiting on another row", test: (task) => task.readiness === "waiting" },
    {
      key: "moving",
      label: "active and recently touched",
      test: (task) => task.statusBase !== null && board.workflow.activeStatuses.includes(task.statusBase),
    },
    { key: "unstated", label: "carrying no status at all", test: (task) => task.statusBase === null },
    { key: "other", label: "queued behind nothing in particular", test: () => true },
  ];

  const counted = new Set<string>();
  const folded: FoldedReason[] = reasons
    .map((reason) => {
      const matched = rest.filter((task) => !counted.has(task.id) && reason.test(task));
      for (const task of matched) counted.add(task.id);
      return { key: reason.key, label: reason.label, count: matched.length };
    })
    .filter((reason) => reason.count > 0);

  const shown = groups.reduce((total, group) => total + group.rows.length, 0);
  return {
    groups,
    shown,
    total: tasks.length,
    folded,
    parked: parkedProjects,
    historyReady,
  };
}

export function foldedSummary(now: NowBoard): string {
  return now.folded.map((reason) => `${reason.count} ${reason.label}`).join(", ");
}
