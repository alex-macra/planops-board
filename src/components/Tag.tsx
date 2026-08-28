import type { JSX, ReactNode } from "react";

import { TONE_MARK, TONE_TEXT, type Tone } from "./tone.ts";

export function StatusTag({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ui-text-muted">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_MARK[tone]}`}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

export function Tag({
  tone = "neutral",
  children,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={`tabular inline-flex items-center rounded bg-ui-bg-muted px-1.5 py-0.5 text-[11px] font-medium ${TONE_TEXT[tone]}`}
    >
      {children}
    </span>
  );
}
