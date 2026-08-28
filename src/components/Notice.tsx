import { X } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { TONE_MARK, TONE_TEXT, type Tone } from "./tone.ts";

export function Notice({
  tone,
  title,
  children,
  onDismiss,
}: {
  readonly tone: Tone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly onDismiss?: () => void;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-ui-border bg-ui-bg-raised p-3 text-sm"
    >
      <span className={`w-0.5 shrink-0 self-stretch rounded-full ${TONE_MARK[tone]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className={`font-medium ${TONE_TEXT[tone]}`}>{title}</p> : null}
        {children ? <div className="leading-relaxed text-ui-text-muted">{children}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="focus-ring -m-1 h-fit rounded p-1 text-ui-text-subtle hover:text-ui-text"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
