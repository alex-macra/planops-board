import type { JSX, ReactNode } from "react";

import type { Tone } from "./tone.ts";

/**
 * A filled state pill, for the two views where a state is the headline.
 *
 * `StatusTag` beside it is not a duplicate: a dot and a word is right when the
 * status is one attribute of a row among six, which is every dense view on the
 * board. Now and Stories show a handful of rows whose whole point is what state
 * they are in, and there the fill is what makes fifteen rows readable without
 * reading them. Both resolve against the same `--tone-*` tokens.
 */
const TONE_CLASS: Record<Tone, string> = {
  done: "pill-done",
  progress: "pill-progress",
  review: "pill-review",
  blocked: "pill-blocked",
  deferred: "pill-deferred",
  neutral: "pill-neutral",
};

export function Pill({
  tone = "neutral",
  children,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
}): JSX.Element {
  return <span className={`pill ${TONE_CLASS[tone]}`}>{children}</span>;
}
