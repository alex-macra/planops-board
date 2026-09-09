import type { JSX, ReactNode } from "react";
import { useMemo, useState } from "react";

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

interface DisclosureProps {
  readonly label: string;
  readonly className: string;
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly initiallyOpen?: boolean;
}

function Disclosure({ label, className, summary, children, initiallyOpen = false }: DisclosureProps): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className={`roadmap-disclosure ${className}`} aria-label={label} open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="focus-ring">{summary}</summary>
    <div className="roadmap-body">{children}</div>
  </details>;
}

function Card({ view, onOpen }: { view: StoryView; onOpen: () => void }): JSX.Element {
  const edge = view.state === "blocked" ? "story-card-blocked" : "";
  const source = `${view.story.file} line ${view.story.headingLine}`;
  const kind = view.story.kind === "enabler" ? "Enabler" : "Story";
  return (
    <Disclosure className={`roadmap-outcome ${edge}`} label={`${kind} ${view.story.id} from ${source}`} summary={<>
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
          Full group: {storyProgressLabel(view)}
          {view.missing.length > 0 ? ` · ${view.missing.length} unknown` : ""}
        </span>
        {view.next ? (
          <span>
            {NEXT_LABEL[view.next.kind]} <b>{view.next.taskId}</b>
          </span>
        ) : null}
      </span>
      <span className="roadmap-source">{source}</span>
    </>}>
      <button type="button" className="focus-ring text-sm text-ui-accent hover:underline"
        aria-label={`Open story ${view.story.id} from ${source}`} onClick={onOpen}>Open story</button>
    </Disclosure>
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
    const documents = new Map(board.documents.map((document) => [document.path, document]));
    return (
      [...byProject.entries()]
        .map(([id, stories]) => {
          const project = projects.get(id);
          const byFile = new Map<string, StoryView[]>();
          for (const view of stories) {
            const bucket = byFile.get(view.story.file);
            if (bucket) bucket.push(view);
            else byFile.set(view.story.file, [view]);
          }
          return {
            id,
            label: project?.label.trim() ? project.label : id,
            parked: project?.parked ?? null,
            stories,
            epics: [...byFile].map(([file, members]) => {
              const document = documents.get(file);
              return { file, stories: members, label: document?.title.trim() ? document.title : file };
            }),
          };
        })
        .sort(
          (a, b) =>
            Number(a.parked !== null) - Number(b.parked !== null) ||
            b.stories.length - a.stories.length ||
            a.label.localeCompare(b.label),
        )
    );
  }, [board.projects, board.documents, views]);

  const uncovered = useMemo(() => unassignedTasks(board, tasks), [board, tasks]);

  return (
    <div className="roadmap-hierarchy space-y-6">
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
        <Disclosure className="roadmap-project" key={lane.id} label={`Project ${lane.label}`} initiallyOpen summary={<>
          <span className="roadmap-heading"><span className="view-eyebrow">Project</span><strong>{lane.label}</strong></span>
          <span className="roadmap-count">{lane.epics.length} {lane.epics.length === 1 ? "epic" : "epics"} ·{" "}
            {lane.stories.length} {lane.stories.length === 1 ? "outcome" : "outcomes"}</span>
            {lane.parked ? (
              <span className="pill pill-deferred">parked {lane.parked.since}</span>
            ) : null}
        </>}>
          {lane.epics.map((epic) => <Disclosure className="roadmap-epic" key={JSON.stringify([lane.id, epic.file])}
            label={`Epic ${epic.file} in ${lane.id}`} initiallyOpen summary={<>
              <span className="roadmap-heading"><span className="view-eyebrow">Epic</span><strong>{epic.label}</strong>
                <span className="roadmap-source">{epic.file}</span></span>
              <span className="roadmap-count">{epic.stories.length} {epic.stories.length === 1 ? "outcome" : "outcomes"}</span>
            </>}>
            {epic.stories.map((view) => <Card key={JSON.stringify([view.story.file, view.story.id, view.story.headingLine])}
              view={view} onOpen={() => onSelectStory(view.story.id)} />)}
          </Disclosure>)}
        </Disclosure>
      ))}

      {uncovered.length > 0 ? (
        <div className="now-folded">
          <b>Not in a story yet:</b>
          <span className="tabular">{uncovered.length} rows</span>
          <span>Your current project scope and row filters remain in effect when opening the backlog.</span>
          <button
            type="button"
            className="focus-ring ml-auto text-ui-accent hover:underline"
            onClick={onOpenBacklog}
          >
            Open backlog
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
