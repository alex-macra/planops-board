/**
 * The board's whole status and priority colour vocabulary, in one place.
 *
 * Tones resolve through CSS variables so the same semantics survive both themes.
 */
import type { Workflow } from "../../shared/contracts.ts";

export type Tone = "done" | "progress" | "review" | "blocked" | "deferred" | "neutral";

export function statusTone(base: string | null, workflow: Workflow): Tone {
  if (base === null) return "neutral";
  if (workflow.dependencySatisfiedStatuses.includes(base)) return "done";
  if (workflow.blockedStatuses.includes(base)) return "blocked";
  if (workflow.closedStatuses.includes(base)) return "deferred";
  if (workflow.activeStatuses.includes(base)) return "progress";
  return "neutral";
}

export function priorityTone(priority: string | null, priorityOrder: readonly string[]): Tone {
  const rank = priority === null ? -1 : priorityOrder.indexOf(priority);
  if (rank === 0) return "blocked";
  if (rank === 1) return "deferred";
  return "neutral";
}

/* Tailwind cannot see through a runtime lookup, so every class is written out
 * here rather than assembled from the tone name. */

export const TONE_TEXT: Record<Tone, string> = {
  done: "text-[rgb(var(--tone-done))]",
  progress: "text-[rgb(var(--tone-progress))]",
  review: "text-[rgb(var(--tone-review))]",
  blocked: "text-[rgb(var(--tone-blocked))]",
  deferred: "text-[rgb(var(--tone-deferred))]",
  neutral: "text-ui-text-subtle",
};

export const TONE_MARK: Record<Tone, string> = {
  done: "bg-[rgb(var(--tone-done))]",
  progress: "bg-[rgb(var(--tone-progress))]",
  review: "bg-[rgb(var(--tone-review))]",
  blocked: "bg-[rgb(var(--tone-blocked))]",
  deferred: "bg-[rgb(var(--tone-deferred))]",
  neutral: "bg-ui-text-subtle",
};

/**
 * A collapsed column's rail carries the same tone as its header, but a header is
 * a dot beside a label and a rail is a single vertical word, so there the tone
 * is the text colour itself. Every `--tone-*` value clears 4.5:1 for that reason.
 */
export function statusRailTone(base: string | null, workflow: Workflow): string {
  return TONE_TEXT[statusTone(base, workflow)];
}
