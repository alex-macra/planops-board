import { Drawer } from "../ui/index.tsx";
import type { JSX } from "react";

import type { Board } from "../api.ts";
import { storyProgressLabel, storyStateLabel, storyView, type StoryView } from "../stories.ts";
import { Pill } from "./Pill.tsx";
import { StoryProgress, STORY_STATE_TONE } from "./StoryProgress.tsx";
import { statusTone } from "./tone.ts";

interface Props {
  readonly storyId: string | null;
  readonly board: Board;
  readonly onClose: () => void;
  readonly onSelectTask: (taskId: string) => void;
}

const NEXT_SENTENCE: Record<string, string> = {
  start: "Every dependency is satisfied. Start with",
  "blocked-by": "Nothing inside this story can move until",
};

function useStoryView(board: Board, storyId: string | null): StoryView | null {
  const story = board.stories.find((candidate) => candidate.id === storyId);
  if (!story) return null;
  return storyView(story, new Map(board.tasks.map((task) => [task.id, task])), board.workflow);
}

export function StoryDrawer({ storyId, board, onClose, onSelectTask }: Props): JSX.Element | null {
  const view = useStoryView(board, storyId);
  if (!view) return null;

  const { story } = view;
  const held = view.next?.kind === "blocked-by" ? view.next.taskId : null;
  const outside = held !== null && !story.taskIds.includes(held);

  return (
    <Drawer open onClose={onClose} side="right" size="lg" title={`${story.id} - ${story.title}`}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="story-kind">{story.kind}</span>
          <Pill tone={STORY_STATE_TONE[view.state]}>{storyStateLabel(view.state)}</Pill>
          <span className="tabular text-xs text-ui-text-subtle">{storyProgressLabel(view)}</span>
        </div>

        {/* The sentence is the only thing a story stores. Everything under it is
         * read off the rows, which is what stops the two from disagreeing. */}
        <p className="story-quote">
          {story.kind === "story" && story.role ? (
            <>
              As a <span className="story-role">{story.role}</span>, {story.outcome}, so that{" "}
              {story.soThat}.
            </>
          ) : (
            <>
              {story.outcome}, so that {story.soThat}.
            </>
          )}
        </p>

        <StoryProgress view={view} />

        {view.next ? (
          <p className="text-sm leading-relaxed text-ui-text">
            {NEXT_SENTENCE[view.next.kind]}{" "}
            <button
              type="button"
              className="focus-ring mono text-ui-accent hover:underline"
              onClick={() => onSelectTask(view.next!.taskId)}
            >
              {view.next.taskId}
            </button>
            {outside ? ", which this story does not contain" : ""}.
          </p>
        ) : null}

        {story.demo ? (
          <section className="story-field">
            <h3>Demo</h3>
            <p className="text-sm leading-relaxed text-ui-text">{story.demo}</p>
          </section>
        ) : null}

        <section className="story-field">
          <h3>Delivered by</h3>
          <div className="story-tasklist">
            {view.members.map((task) => (
              <button
                key={task.id}
                type="button"
                className="focus-ring"
                onClick={() => onSelectTask(task.id)}
              >
                <span className="story-tasklist-head">
                  <span className="mono text-[11px] text-ui-accent">{task.id}</span>
                  <Pill tone={statusTone(task.statusBase, board.workflow)}>{task.statusBase ?? "no status"}</Pill>
                </span>
                <span className="text-ui-text">{task.title ?? task.outcome}</span>
              </button>
            ))}
          </div>
          {view.missing.length > 0 ? (
            <p className="text-xs text-[rgb(var(--tone-blocked))]">
              {view.missing.join(", ")} named here but defined by no ledger row.
            </p>
          ) : null}
        </section>

        <section className="story-field">
          <h3>Ships when</h3>
          <p className="text-sm leading-relaxed text-ui-text">
            Every row above reaches a configured dependency-satisfying status. The board computes
            that state and does not provide a separate control for changing it.
          </p>
        </section>

        <section className="story-field">
          <h3>Written in</h3>
          <p className="text-sm text-ui-text-muted">
            {story.file} line {story.headingLine}
          </p>
        </section>

        {view.repositories.length > 0 ? (
          <section className="story-field">
            <h3>Repositories</h3>
            <p className="text-sm text-ui-text-muted">{view.repositories.join(", ")}</p>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}
