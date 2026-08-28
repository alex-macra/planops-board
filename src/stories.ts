import type { Board, Story, Task, Workflow } from "../shared/contracts.ts";
import { comparePriority } from "./priority.ts";

export type { Story, StoryKind } from "../shared/contracts.ts";

export type StoryState = "shipped" | "in-flight" | "blocked" | "not-started";

export interface StoryNext {
  readonly kind: "start" | "blocked-by";
  readonly taskId: string;
}

export interface StorySegment {
  readonly key: "done" | "progress" | "blocked" | "open";
  readonly count: number;
}

export interface StoryView {
  readonly story: Story;
  readonly members: readonly Task[];
  readonly missing: readonly string[];
  readonly state: StoryState;
  readonly complete: number;
  readonly segments: readonly StorySegment[];
  readonly next: StoryNext | null;
  readonly projects: readonly string[];
  readonly repositories: readonly string[];
}

const STATE_LABEL: Record<StoryState, string> = {
  shipped: "shipped",
  "in-flight": "in flight",
  blocked: "blocked",
  "not-started": "not started",
};

export function storyStateLabel(state: StoryState): string {
  return STATE_LABEL[state];
}

export function storyProgressLabel(view: StoryView): string {
  return `${view.complete} of ${view.members.length} complete`;
}

function isSatisfied(task: Task, workflow: Workflow): boolean {
  return task.statusBase !== null && workflow.dependencySatisfiedStatuses.includes(task.statusBase);
}

function segmentOf(task: Task, workflow: Workflow): StorySegment["key"] {
  if (isSatisfied(task, workflow)) return "done";
  if (task.statusBase !== null && workflow.activeStatuses.includes(task.statusBase)) return "progress";
  if (
    task.readiness === "waiting" ||
    task.readiness === "needs-gate-check" ||
    (task.statusBase !== null && workflow.blockedStatuses.includes(task.statusBase))
  ) return "blocked";
  return "open";
}

function blocker(
  members: readonly Task[],
  byId: ReadonlyMap<string, Task>,
  workflow: Workflow,
): string | null {
  const own = new Set(members.map((task) => task.id));
  const outside: string[] = [];
  const inside: string[] = [];
  for (const member of members) {
    for (const dependency of member.dependencies) {
      const target = byId.get(dependency.id);
      if (!target || isSatisfied(target, workflow)) continue;
      (own.has(dependency.id) ? inside : outside).push(dependency.id);
    }
  }
  return outside[0] ?? inside[0] ?? null;
}

function stateOf(
  members: readonly Task[],
  missing: number,
  workflow: Workflow,
): StoryState {
  if (members.length === 0) return "not-started";
  if (missing === 0 && members.every((task) => isSatisfied(task, workflow))) return "shipped";
  if (members.some((task) =>
    isSatisfied(task, workflow) ||
    (task.statusBase !== null && workflow.activeStatuses.includes(task.statusBase)),
  )) return "in-flight";
  return members.some((task) => task.readiness === "startable") ? "not-started" : "blocked";
}

function nextOf(
  state: StoryState,
  members: readonly Task[],
  byId: ReadonlyMap<string, Task>,
  workflow: Workflow,
): StoryNext | null {
  if (state === "shipped") return null;
  const startable = members.filter((task) =>
    task.readiness === "startable" && !isSatisfied(task, workflow),
  );
  if (startable.length > 0) {
    return {
      kind: "start",
      taskId: [...startable].sort((a, b) => comparePriority(a, b, workflow.priorityOrder))[0]!.id,
    };
  }
  const held = blocker(members, byId, workflow);
  return held ? { kind: "blocked-by", taskId: held } : null;
}

export function storyView(
  story: Story,
  byId: ReadonlyMap<string, Task>,
  workflow: Workflow,
): StoryView {
  const members = story.taskIds.flatMap((id) => {
    const task = byId.get(id);
    return task ? [task] : [];
  });
  const missing = story.taskIds.filter((id) => !byId.has(id));
  const counts = new Map<StorySegment["key"], number>();
  for (const member of members) {
    const key = segmentOf(member, workflow);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order: readonly StorySegment["key"][] = ["done", "progress", "blocked", "open"];
  const state = stateOf(members, missing.length, workflow);
  return {
    story,
    members,
    missing,
    state,
    complete: counts.get("done") ?? 0,
    segments: order.flatMap((key) => {
      const count = counts.get(key) ?? 0;
      return count > 0 ? [{ key, count }] : [];
    }),
    next: nextOf(state, members, byId, workflow),
    projects: [...new Set(members.flatMap((task) => [task.project, ...task.projects]))],
    repositories: [...new Set(members.flatMap((task) => task.repositories))],
  };
}

const STATE_ORDER: readonly StoryState[] = ["in-flight", "blocked", "not-started", "shipped"];

export function storyViews(board: Board): StoryView[] {
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  return board.stories
    .map((story) => storyView(story, byId, board.workflow))
    .sort((a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      a.story.id.localeCompare(b.story.id),
    );
}

export function storyViewsInScope(board: Board, tasks: readonly Task[]): StoryView[] {
  const inScope = new Set(tasks.map((task) => task.id));
  return storyViews(board).filter(
    (view) => view.members.length === 0 || view.members.some((task) => inScope.has(task.id)),
  );
}

export function unassignedTasks(board: Board, tasks: readonly Task[]): Task[] {
  const claimed = new Set(board.stories.flatMap((story) => story.taskIds));
  return tasks.filter((task) => !claimed.has(task.id));
}
