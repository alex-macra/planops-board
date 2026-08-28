import type { JSX } from "react";
import { useMemo } from "react";

import type { Board, Task } from "../api.ts";
import { Pill } from "../components/Pill.tsx";
import { StoryProgress, STORY_STATE_TONE } from "../components/StoryProgress.tsx";
import {
  storyProgressLabel,
  storyStateLabel,
  storyViewsInScope,
  unassignedTasks,
  type StoryView,
} from "../stories.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly onSelectStory: (storyId: string) => void;
  readonly onOpenBacklog: () => void;
}

const NEXT_LABEL = { start: "next", "blocked-by": "blocked by" } as const;

/** The short form, for a card. The drawer prints the whole sentence. */
export function storyLine(view: StoryView): JSX.Element {
  const { story } = view;
  if (story.kind === "enabler" || !story.role) {
    return <>{story.outcome}</>;
  }
  return (
    <>
      As a <span className="story-role">{story.role}</span>, {story.outcome}
    </>
  );
}

function Card({ view, onOpen }: { view: StoryView; onOpen: () => void }): JSX.Element {
  const edge = view.state === "blocked" ? "story-card-blocked" : "";
  return (
    <button type="button" className={`story-card focus-ring ${edge}`} onClick={onOpen}>
      <span className="story-card-top">
        <span className="story-card-id">{view.story.id}</span>
        <span className="story-kind">{view.story.kind}</span>
        <span className="ml-auto">
          <Pill tone={STORY_STATE_TONE[view.state]}>{storyStateLabel(view.state)}</Pill>
        </span>
      </span>

      <span className="story-line">{storyLine(view)}</span>

      <StoryProgress view={view} />

      <span className="story-foot">
        <span>
          {storyProgressLabel(view)}
          {view.missing.length > 0 ? ` · ${view.missing.length} unknown` : ""}
        </span>
        {view.next ? (
          <span>
            {NEXT_LABEL[view.next.kind]} <b>{view.next.taskId}</b>
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function Stories({ board, tasks, onSelectStory, onOpenBacklog }: Props): JSX.Element {
  const views = useMemo(() => storyViewsInScope(board, tasks), [board, tasks]);

  /**
   * Laned by the products the member rows actually touch, not by the epic file:
   * a story is an outcome, and an outcome belongs to whoever would notice it.
   */
  const lanes = useMemo(() => {
    const projects = new Map(board.projects.map((project) => [project.id, project]));
    const byProject = new Map<string, StoryView[]>();
    for (const view of views) {
      const key = view.projects[0] ?? "unassigned";
      const bucket = byProject.get(key);
      if (bucket) bucket.push(view);
      else byProject.set(key, [view]);
    }
    return (
      [...byProject.entries()]
        .map(([id, stories]) => ({
          id,
          label: projects.get(id)?.label ?? id,
          parked: projects.get(id)?.parked ?? null,
          stories,
        }))
        .sort(
          (a, b) =>
            Number(a.parked !== null) - Number(b.parked !== null) ||
            b.stories.length - a.stories.length ||
            a.label.localeCompare(b.label),
        )
    );
  }, [board.projects, views]);

  const uncovered = useMemo(() => unassignedTasks(board, tasks), [board, tasks]);

  return (
    <div className="space-y-6">
      <div className="rollup-context">
        <p>
          {views.length} {views.length === 1 ? "story" : "stories"} over{" "}
          {tasks.length - uncovered.length} of {tasks.length} rows. Story state and progress are
          derived from the tasks assigned to it.
        </p>
        <p>
          A <b>story</b> names a role. An <b>enabler</b> names the capability instead, for the
          platform work that has no end user.
        </p>
      </div>

      {lanes.map((lane) => (
        <section className="story-lane" key={lane.id}>
          <div className="story-lane-head">
            <h2>{lane.label}</h2>
            <span>
              {lane.stories.length} {lane.stories.length === 1 ? "story" : "stories"}
            </span>
            {lane.parked ? (
              <span className="pill pill-deferred">parked {lane.parked.since}</span>
            ) : null}
          </div>
          <div className="story-grid">
            {lane.stories.map((view) => (
              <Card key={view.story.id} view={view} onOpen={() => onSelectStory(view.story.id)} />
            ))}
          </div>
        </section>
      ))}

      {uncovered.length > 0 ? (
        <div className="now-folded">
          <b>Not in a story yet:</b>
          <span className="tabular">{uncovered.length} rows</span>
          <span>
            · coverage is deliberately optional, so the gap is shown rather than hidden and shrinks
            as sentences land.
          </span>
          <button
            type="button"
            className="focus-ring ml-auto text-ui-accent hover:underline"
            onClick={onOpenBacklog}
          >
            Open them in the backlog
          </button>
        </div>
      ) : null}

      {views.length === 0 ? (
        <p className="text-sm text-ui-text-muted">
          No story blocks in this scope yet. A story is a{" "}
          <code className="mono text-xs">### PREFIX-S01</code> block in an epic file; see
          the README for the supported fields.
        </p>
      ) : null}
    </div>
  );
}
