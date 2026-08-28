import type { JSX } from "react";

import type { Tone } from "./tone.ts";
import type { StoryState, StoryView } from "../stories.ts";

export const STORY_STATE_TONE: Record<StoryState, Tone> = {
  shipped: "done",
  "in-flight": "progress",
  blocked: "blocked",
  "not-started": "neutral",
};

const SEGMENT_TONE = {
  done: "bg-[rgb(var(--tone-done))]",
  progress: "bg-[rgb(var(--tone-progress))]",
  blocked: "bg-[rgb(var(--tone-blocked))]",
  open: "bg-transparent",
} as const;

export function StoryProgress({ view }: { readonly view: StoryView }): JSX.Element {
  const total = view.members.length;
  if (total === 0) return <span className="story-bar" aria-hidden="true" />;
  return (
    <span
      className="story-bar"
      role="progressbar"
      aria-label={`${view.complete} of ${total} tasks complete`}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={view.complete}
    >
      {view.segments.map((segment) => (
        <span
          key={segment.key}
          className={SEGMENT_TONE[segment.key]}
          style={{ width: `${(segment.count / total) * 100}%` }}
        />
      ))}
    </span>
  );
}
